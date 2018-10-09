// Crashes application on unhandled Promise rejection instead of just printing a warning to console
process.on("unhandledRejection", err => { throw err })

const os = require("os")
const url = require("url")
const util = require("util")
const path = require("path")
const fs = require("fs")

const Ajv = require("ajv")
const express = require("express")
const tar = require("tar-fs")
const gunzip = require("gunzip-maybe")
const klaw = require("klaw-sync")
const protobuf = require("protobufjs")
const ipfsAPI = require("ipfs-api")
const Web3 = require("web3")

const agentABI = require("singularitynet-platform-contracts/abi/Agent.json")

function getConfig(configPath) {
  if (typeof configPath !== "undefined") {
    const configAbsolutePath = path.isAbsolute(configPath) ? configPath : path.join(__dirname, configPath)
    if (!fs.existsSync(configAbsolutePath)) { throw new Error(`configuration file not found at ${configAbsolutePath}`) }
    const config = require(configAbsolutePath)
    const configSchema = require(path.join(__dirname, "config.schema.json"))

    const ajv = new Ajv()
    if (!ajv.validate(configSchema, config)) { throw new Error(ajv.errorsText()) }
    return config
  } else {
    return {
      "ipfsEndpoint": "http://localhost:5001",
      "ethereumRPCEndpoint": "http://localhost:8545",
      "port": 9000
    }
  }
}

const config = getConfig(process.argv[2])

const METADATA_JSON_DIR = path.join(__dirname, "metadata")
const MODELS_TAR_DIR = path.join(__dirname, "models", "tar")
const MODELS_PROTO_DIR = path.join(__dirname, "models", "proto")
const MODELS_JSON_DIR = path.join(__dirname, "models", "json")
const ETHEREUM_ENDPOINT = typeof config.network !== "undefined" ?
  `https://${config.network}.infura.io/${config.infuraKey || ""}` :
  config.ethereumRPCEndpoint

const IPFS_ENDPOINT = config.ipfsEndpoint
const IPFS_ENDPOINT_OBJECT = url.parse(IPFS_ENDPOINT)
if (IPFS_ENDPOINT_OBJECT.protocol === null) { throw new Error(`IPFS_ENDPOINT must include a protocol (ex: "https://"). ${JSON.stringify(IPFS_ENDPOINT)}`) }
if (IPFS_ENDPOINT_OBJECT.hostname === null) { throw new Error(`IPFS_ENDPOINT must include a hostname (ex: "ipfs.io"). ${JSON.stringify(IPFS_ENDPOINT)}`) }
if (IPFS_ENDPOINT_OBJECT.port === null) { throw new Error(`IPFS_ENDPOINT must include a port (ex: ":80"). ${JSON.stringify(IPFS_ENDPOINT)}`) }
const PORT = config.port

const app = express()
const ipfs = ipfsAPI(IPFS_ENDPOINT_OBJECT.hostname, IPFS_ENDPOINT_OBJECT.port, { "protocol": IPFS_ENDPOINT_OBJECT.protocol.slice(0, -1) })
const web3 = new Web3(new Web3.providers.HttpProvider(ETHEREUM_ENDPOINT))

const readFile = util.promisify(fs.readFile)

const agent = new web3.eth.Contract(agentABI)
// Keep key=>value cache of initialized agent contracts
const agents = {}
// Keep key=>value cache of serviceNames for proto definitions
const serviceNames = {}


class NotFoundError extends Error {}
class BadRequestError extends Error {}

function getErrorStatusCode(e) {
  switch (e.constructor.name) {
    case "NotFoundError":
      return 404
    case "BadRequestError":
      return 400
    default:
      console.error(e.message)
      return 500
  }
}


function uriToHash(uri) {
  return uri.split("/").slice(-1).join("") 
}

function untar(sourceFile, destDir) {
  const stream = fs.createReadStream(sourceFile).pipe(gunzip()).pipe(tar.extract(destDir))
  return new Promise((resolve, reject) => {
    stream.on("end", () => { resolve("end") })
    stream.on("finish", () => { resolve("finish") })
    stream.on("error", error => { reject(error) })
  })
}

async function getContractMetadataURI(address) {
  if (!web3.utils.isAddress(address) && address !== "test") {
    throw new BadRequestError(`${address} is not a valid Ethereum address`)
  }

  if (!agents.hasOwnProperty(address)) {
    agents[address] = agent.clone()
    agents[address].options.address = address
  }

  try {
    return await agents[address].methods.metadataURI().call() 
  } catch(e) {
    if (e.message.startsWith("Returned values aren't valid")) {
      throw new NotFoundError(`Error while trying to get metadataURI for address ${address}. ${address} is probably not an instance of an Agent contract. ${e}`)
    } else {
      throw new Error(e)
    } 
  }
}

async function getModelURI(metadataJSONHash) {
  const metadataJSONPath = path.join(METADATA_JSON_DIR, metadataJSONHash)
  let metadataJSON = undefined
  if (!fs.existsSync(metadataJSONPath)) {
    try {
      metadataJSON = await ipfs.cat(metadataJSONHash)
      fs.writeFileSync(metadataJSONPath, metadataJSON, "utf8")
    } catch(e) {
      throw new Error(`Failed to get object ${metadataJSONHash} from IPFS endpoint ${IPFS_ENDPOINT}. Error: ${e.message}`)
    }
  } else {
    metadataJSON = fs.readFileSync(metadataJSONPath, "utf8")
  }
  return JSON.parse(metadataJSON.toString("utf-8")).modelURI
}

async function getProtoServiceName(metadataJSONHash, protoPath) {
  if (!serviceNames.hasOwnProperty(metadataJSONHash)) {
    const files = await Promise.all(klaw(protoPath, { "nodir": true }).map(file => readFile(file.path, "utf8")))
    const services = files
      .map(file =>
        file.split(os.EOL)
          .filter(line =>
            line.startsWith("service")
          )
      ).reduce((acc, cur) => acc.concat(cur), [])
    if (services.length > 1) { throw new BadRequestError("Service spec has more than 1 service") }
    else if (services.length < 1) { throw new BadRequestError("No service in service spec") }
    else {
      serviceNames[metadataJSONHash] = services[0].split(" ")[1]
    }
  }
  return serviceNames[metadataJSONHash]
}

async function getModelJSON(metadataJSONHash) {
  const jsonPath = path.join(MODELS_JSON_DIR, metadataJSONHash)
  if (!fs.existsSync(jsonPath)) {
    const protoPath = path.join(MODELS_PROTO_DIR, metadataJSONHash)
    if (!fs.existsSync(protoPath)) {
      const tarPath = path.join(MODELS_TAR_DIR, metadataJSONHash)
      if (!fs.existsSync(tarPath)) {
        const modelTar = await ipfs.cat(uriToHash(await getModelURI(metadataJSONHash)))
        fs.writeFileSync(tarPath, modelTar)
      }
      await untar(tarPath, protoPath)
    }
    const serviceName = await getProtoServiceName(metadataJSONHash, protoPath)
    const root = await protobuf.load(path.join(protoPath, `${serviceName}.proto`))
    fs.writeFileSync(jsonPath, JSON.stringify(root), "utf8")
  }
  return fs.readFileSync(jsonPath, "utf8")
}


app.get("/:address", async (req, res) => {
  try {
    const metadataJSONHash = req.params.address === "test" ? "test" : uriToHash(await getContractMetadataURI(req.params.address))
    const modelJSON = await getModelJSON(metadataJSONHash)
    return res.type("json").status(200).send(modelJSON)
  } catch(e) {
    return res.type("json").status(getErrorStatusCode(e)).send({ "error": e.message })
  }
})

app.get("*", (req, res) => res.type("json").status(404).send({ "error": `${req.method} ${req.originalUrl} not found` }))

app.disable("x-powered-by")
app.listen(PORT, () => {
  console.log("Running on port", PORT) }
)
