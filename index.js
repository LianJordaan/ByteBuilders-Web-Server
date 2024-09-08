const express = require("express");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser"); // To parse JSON bodies
const Docker = require("dockerode");
const http = require("http");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const url = require("url");
const { exec } = require('child_process');
const util = require('util');
const AdmZip = require('adm-zip');
const archiver = require('archiver'); // Use the 'archiver' package to create a ZIP file
const tar = require('tar'); // Required for extracting files from the Docker container
const { type } = require("os");

const IDLE_SERVER_COUNT = 1;

const dataFolderPath = path.join(__dirname, 'data');
if (!fs.existsSync(dataFolderPath)) {
    fs.mkdirSync(dataFolderPath);
}

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const docker = new Docker({ socketPath: "//./pipe/docker_engine" });

const VALID_USERNAMES = process.env.VALID_USERNAMES ? process.env.VALID_USERNAMES.split(",") : [];
var serversList = {};
loadServerInfo();

// Middleware to parse JSON bodies
app.use(bodyParser.json());
app.use(express.json()); // Make sure you can parse JSON request bodies
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/list-plots", async (req, res) => {
	try {
		const containers = await docker.listContainers({ all: true });
		const plotStatuses = await Promise.all(
			containers.map(async (container) => {
				const containerObj = docker.getContainer(container.Id);
				const data = await containerObj.inspect();
				return {
					id: container.Id,
					name: container.Names[0],
					status: data.State.Running,
				};
			})
		);

		res.send({ success: true, message: "List of plots", plotStatuses });
	} catch (err) {
		console.error("Error listing plots:", err);
		res.status(500).send({
			success: false,
			message: "Failed to list plots.",
		});
	}
});

app.get("/plot-status", async (req, res) => {
	const { port } = req.query;

	if (!port) {
		return res.status(400).send({ success: false, message: "port is required." });
	}

	try {
		const container = docker.getContainer(`dyn-${port}`);
		const status = await container.inspect();
		res.send({ success: true, message: "Plot status", status });
	} catch (err) {
		console.error("Error getting container status:", err);
		res.status(500).send({
			success: false,
			message: "Failed to get container status.",
		});
	}
});

async function restoreFilesToContainer(container, port, id) {
    const tempFolder = path.join(__dirname, 'temp', `dyn-${port}`);
    const zipFilePath = path.join(__dirname, 'data', `plot-${id}`, 'data.zip');

    if (!fs.existsSync(zipFilePath)) {
        console.log(`No zip file found for container dyn-${port}. Skipping restore.`);
        return;
    }

    // Create the temporary directory if it does not exist
    fs.mkdirSync(tempFolder, { recursive: true });

    console.log(`Extracting ${zipFilePath} to ${tempFolder}...`);

    // Extract the zip file to the temporary folder
    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(tempFolder, true);

    console.log(`Files extracted to ${tempFolder}.`);

    console.log(`Restoring files from ${tempFolder} to container dyn-${port}...`);

    // Create a tar archive stream from the temporary folder
    const archiveStream = tar.c(
        {
            cwd: tempFolder, // Create the tarball from the temporary folder
            gzip: true,
            portable: true
        },
        ['.'] // Include all files and directories in the temporary folder
    );

    // Upload the tar archive to the /minecraft directory in the container
    await container.putArchive(archiveStream, { path: '/minecraft' });

    // Remove the temporary folder
    fs.rmSync(tempFolder, { recursive: true, force: true });

    console.log(`All files from ${tempFolder} have been restored to container dyn-${port}.`);
}

async function sendActionAndWaitForResponse(websocketOfServer, action) {
    return new Promise((resolve, reject) => {
        const responseHandler = (event) => {
            const message = JSON.parse(event.data);
            if (message.type === "action" && message.action === action && message.status === "done") {
                websocketOfServer.removeEventListener('message', responseHandler);
                resolve();
            }
        };

        websocketOfServer.addEventListener('message', responseHandler);

        websocketOfServer.send(
            JSON.stringify({
                type: "action",
                action: action
            })
        );
    });
}

app.post("/start-server", async (req, res) => {
    const { id } = req.body;

    if (!id) {
        return res.status(400).send({ success: false, message: "id is required." });
    }

	for (const port of Object.keys(serversList)) {
		if (serversList[port].status === "running" && serversList[port].plotId == id) {
			return res.status(409).send({ success: false, port: port, message: "Server is already running." });
		}
	}

	//check if there is a server inside serverList that is status running with no id assigned
	for (const port of Object.keys(serversList)) {
		if (serversList[port].status === "running" && !serversList[port].plotId) {
			// If there is a server with status running and no id assigned, set id to the expected id and return good reponse
			serversList[port].plotId = id;
			return res.status(200).send({ success: true, port: port, message: "Empty server found and assigned id." });
		}
	}

	//check if there is a server inside serverList that is in a starting status with no id assigned
	for (const port of Object.keys(serversList)) {
		if (serversList[port].status === "starting" && !serversList[port].plotId) {
			// If there is a server with status starting and no id assigned
			return res.status(202).send({ success: false, port: port, message: "A server is starting, please wait for it to become available." });
		}
	}

    try {
        // Find the next available port starting from 25566
        const startingPort = 25566;
        const nextPort = findNextAvailablePort(startingPort);

        if (!nextPort) {
            return res.status(500).send({
                success: false,
                message: "No available ports to start a new server.",
            });
        }

        // Define the image and container name
        const imageName = "minecraft-server"; // Use your Docker image name
        const containerName = `dyn-${nextPort}`;

        // Create and start the container
        const container = await docker.createContainer({
            Image: imageName,
            name: containerName,
            ExposedPorts: { [`${nextPort}/tcp`]: {} },
            HostConfig: {
                PortBindings: {
                    [`${nextPort}/tcp`]: [{ HostPort: nextPort.toString() }],
                },
                // AutoRemove: true,
                DiskQuota: 1 * 1024 * 1024 * 1024, // 1 GB
                Memory: 1 * 1024 * 1024 * 1024, // 1 GB
                CpuQuota: 30000, // 30,000 microseconds
                CpuPeriod: 10000, // 10,000 microseconds
            },
            Env: [`PORT=${nextPort}`], // Pass the port as an environment variable
        });

        // Start the container
        await container.start();

        serversList[nextPort] = { plotId: null, status: "starting" };

        // Send response once everything is done
        res.status(404).send({
            success: true,
            message: `Container ${containerName} starting on port ${nextPort}.`,
        });
    } catch (err) {
        console.error("Error starting container:", err);
        res.status(500).send({
            success: false,
            message: "Failed to start container.",
        });
    }
});

// Function to find the next available port
function findNextAvailablePort(startingPort) {
    let port = startingPort;
    
    // Iterate to find the next available port
    while (serversList[port] !== undefined) {
        port++;
    }

    // Check if the port is within a valid range
    if (port > 26000) {
        // No available ports found within range
        return null;
    }

    return port;
}

app.get("/list-server-statuses", async (req, res) => {
	let statusObject = {};
	for (const port of Object.keys(serversList)) {
		const server = serversList[port];
		statusObject[port] = {
			status: server.status,
			plotId: server.plotId,
		};
	}
	res.send(statusObject);
});

app.post("/stop-server", async (req, res) => {
	const { port } = req.body;

	if (!port) {
		return res.status(400).send({ success: false, message: "port is required." });
	}

	try {
		const container = docker.getContainer(`dyn-${port}`);
		await container.stop();
		res.send({ success: true, message: `Container dyn-${port} stopped.` });
	} catch (err) {
		console.error("Error stopping container:", err);
		res.status(500).send({
			success: false,
			message: "Failed to stop container.",
		});
	}
});

async function checkServerStatuses() {
	// Iterate through all servers in the list
	for (const port of Object.keys(serversList)) {
		const server = serversList[port];
		if (!server) {
			console.warn(`Server with port ${port} is undefined. Skipping...`);
			continue; // Skip to the next iteration if server is undefined
		}

		let id = server.plotId;

		try {
			const container = docker.getContainer(`dyn-${port}`);
			const status = await container.inspect();

			if (server.status === "running") {
				// Check if the server in 'running' status is still healthy
				if (status.State.Status === "running") {
					// Container is healthy and running; no action needed here
				} else {
					console.log(`Server dyn-${port} is not healthy or not running.`);
					// Stop the container if it is still running
					if (status.State.Status === "running") {
						await container.stop();
						console.log(`Stopped container dyn-${port}.`);
					}
					// Update server status to 'stopped' and remove from the list
					server.status = "stopping";
					// delete serversList[port];
				}
			} else if (server.status === "stopping") {
                if (status.State.Status !== "running") {
                    console.log(`Server dyn-${port} is stopping and container is not running.`);
					if (id) {
						server.status = "saving";

						// Copy files from the Docker container
						await copyFilesFromContainer(container, port);

						// Zip the copied files
						await zipServerFiles(port, id);
					}
					await container.remove();
                    server.status = "stopped";
                    delete serversList[port];
                }
            }
		} catch (err) {
			// Check if the error is due to the container not existing
			if (err.statusCode === 404) {
				console.log(`Container dyn-${port} does not exist. Removing from server list.`);
				// Remove the server entry from the list
				delete serversList[port];
			} else {
				console.error("Error inspecting container:", err);
			}
		}
	}

	await ensureServerAvailable();
}

async function ensureServerAvailable() {
    // Count the number of servers in "running" or "starting" state without an ID
    const countServersWithoutId = Object.values(serversList).filter(server => 
        (server.status === "running" || server.status === "starting") && !server.plotId
    ).length;

    if (countServersWithoutId < IDLE_SERVER_COUNT) {
        // Less than two servers found, start a new one
        console.log("Less than two servers without an ID found. Starting a new one...");
        await startServerWithoutId();
    }
}

async function startServerWithoutId() {
    try {
        const startingPort = 25566;
        const nextPort = findNextAvailablePort(startingPort);

        if (!nextPort) {
            console.error("No available ports to start a new server.");
            return;
        }

        const imageName = "minecraft-server";
        const containerName = `dyn-${nextPort}`;

        const container = await docker.createContainer({
            Image: imageName,
            name: containerName,
            ExposedPorts: { [`${nextPort}/tcp`]: {} },
            HostConfig: {
                PortBindings: {
                    [`${nextPort}/tcp`]: [{ HostPort: nextPort.toString() }],
                },
                DiskQuota: 1 * 1024 * 1024 * 1024, // 1 GB
                Memory: 1 * 1024 * 1024 * 1024, // 1 GB
                CpuQuota: 30000, // 30,000 microseconds
                CpuPeriod: 10000, // 10,000 microseconds
            },
            Env: [`PORT=${nextPort}`],
        });

        await container.start();

        serversList[nextPort] = { plotId: null, status: "starting" };

        console.log(`New server started without ID on port ${nextPort}.`);
    } catch (err) {
        console.error("Error starting a server without ID:", err);
    }
}

// Function to check if a file path should be excluded based on patterns
function shouldExclude(filePath, excludePatterns) {
    return excludePatterns.some(pattern => minimatch(filePath, pattern));
}

// Function to copy files from the Docker container to the temporary folder
async function copyFilesFromContainer(container, port) {
    // Define paths inside the container, including wildcards
	const containerPaths = [
		"/minecraft/world*/",
		"/minecraft/custom-dim*/",
		"/minecraft/plugins/",
		"/minecraft/vars.json"
	];	

    // Define the temporary folder for this server backup
    const tempFolder = path.join(__dirname, 'temp', `dyn-${port}`);

    // Create the temporary directory if it does not exist
    fs.mkdirSync(tempFolder, { recursive: true });

    // Define exclusions (folder or file patterns)
    const excludePatterns = [
        "**/plugins/.paper-remapped/", // Exclude specific folder
    ];

    // Copy each folder from the container to the temporary directory
    for (const containerPath of containerPaths) {
        const stream = await container.getArchive({ path: containerPath });

        await new Promise((resolve, reject) => {
            stream.pipe(
                tar.x({
                    cwd: tempFolder, // Extract the files to the temporary folder
                    filter: (filePath) => {
                        // Apply the exclusion filter
                        if (shouldExclude(filePath, excludePatterns)) {
                            console.log(`Excluding ${filePath} from the backup.`);
                            return false; // Exclude this file/folder
                        }
                        return true; // Include this file/folder
                    }
                })
                .on('finish', resolve)
                .on('error', reject)
            );
        });

        console.log(`Copied ${containerPath} from container dyn-${port} to temporary folder.`);
    }
}

// Function to zip the copied server files and clean up
async function zipServerFiles(port, id) {
    // Define the temporary folder and the final zip destination
    const tempFolder = path.join(__dirname, 'temp', `dyn-${port}`);
    const zipDestination = path.join(__dirname, 'data', `plot-${id}`, `data.zip`);

    // Ensure the parent directory for the zip exists
    fs.mkdirSync(path.dirname(zipDestination), { recursive: true });

    const output = fs.createWriteStream(zipDestination);
    const archive = archiver('zip', { zlib: { level: 9 } }); // Maximum compression

    output.on('close', () => {
        console.log(`Backup for server dyn-${port} completed: ${archive.pointer()} total bytes.`);

        // Delete the temporary folder after zipping
        fs.rm(tempFolder, { recursive: true, force: true }, (err) => {
            if (err) console.error(`Error deleting temporary folder: ${err}`);
            else console.log(`Temporary folder deleted: ${tempFolder}`);
        });
    });

    archive.on('error', (err) => {
        throw err;
    });

    // Connect the archive stream to the output file
    archive.pipe(output);

    // Add folders to the ZIP file
    archive.directory(path.join(tempFolder, 'world'), 'world');
    archive.directory(path.join(tempFolder, 'plugins'), 'plugins');

    await archive.finalize(); // Finalize the ZIP file
}

setInterval(checkServerStatuses, 5000);

function saveServerInfo() {
	fs.writeFileSync("serverInfo.json", JSON.stringify(serversList, null, 2), "utf-8");
	console.log("Server info saved to serverInfo.json");
}

function loadServerInfo() {
	try {
		const data = fs.readFileSync("serverInfo.json", "utf-8");
		serversList = JSON.parse(data);
		console.log("Server info loaded from serverInfo.json");
	} catch (err) {
		console.error("Error loading server info:", err);
		// Initialize serversList as an empty object if the file does not exist
		serversList = {};
	}
}

// Graceful shutdown handler to save server info
process.on("SIGTERM", () => {
	console.log("SIGTERM signal received: closing HTTP server");
	saveServerInfo();
	// Close other connections and cleanup...
	process.exit(0);
});

process.on("SIGINT", () => {
	console.log("SIGINT signal received: closing HTTP server");
	saveServerInfo();
	// Close other connections and cleanup...
	process.exit(0);
});

const clients = new Map(); // Store connected clients with unique IDs

// Handle WebSocket upgrade requests
server.on("upgrade", (request, socket, head) => {
	const { query } = url.parse(request.url, true);
	const username = query.username;

	// Validate username
	if (!VALID_USERNAMES.includes(username)) {
		socket.destroy(); // Reject connection if username is invalid
		console.log("WebSocket connection rejected due to invalid username");
		return;
	}

	// Proceed with WebSocket upgrade if username is valid
	wss.handleUpgrade(request, socket, head, (ws) => {
		wss.emit("connection", ws, request);
	});
});

wss.on("connection", (ws, req) => {
	const urlParams = new URLSearchParams(req.url.split("?")[1]);
	const username = urlParams.get("username"); // Get username from URL
	const id = urlParams.get("id"); // Get unique ID from URL

	// Add client to the map
	clients.set(id, ws);

	//client registered with unique id
	console.log(`Client registered with id: ${id}`);

	ws.on("message", async (message) => {
		try {
			const parsedMessage = JSON.parse(message);
			console.log("Received message:", parsedMessage);

			// Check if the message needs to be forwarded
			if (parsedMessage.targetId && clients.has(parsedMessage.targetId)) {
				//example json to trigger forwarding
				//{"type":"forwarded-message","targetId":"25566","message":"Hello, this is a forwarded message!"}

				const targetClient = clients.get(parsedMessage.targetId);
				targetClient.send(
					JSON.stringify({
						type: "forwarded-message",
						from: id,
						message: parsedMessage.message,
					})
				);
			}

			//example of json to trigger status update
			//{"type": "status", "status": "running"}
			if (parsedMessage.type === "status") {
				if (parsedMessage.type === "status" && parsedMessage.status) {
					if (serversList[id]) {
						serversList[id].status = parsedMessage.status;
						if (parsedMessage.status === "running") {
							try {
								const container = docker.getContainer(`dyn-${id}`);
								await container.update({
									// Default to 50% of CPU Core
									CpuQuota: 5000, // 5,000 microseconds
									CpuPeriod: 10000, // 10,000 microseconds
								});
								console.log(`Server dyn-${id} updated with CPU limits.`);
							} catch (err) {
								if (err.statusCode === 404) {
									console.log(`Container dyn-${port} does not exist. Removing from server list.`);
									// Remove the server entry from the list
									delete serversList[port];
								} else {
									console.error("Error inspecting container:", err);
								}
							}
						}
						// if (parsedMessage.status === "stopping") {
						// 	delete serversList[id];
						// }
						console.log(`Updated status of server ${id} to ${parsedMessage.status}`);
					}
				}
			}
		} catch (error) {
			ws.send(JSON.stringify({ type: "error", message: "Invalid message format! Please use json format." }));
		}
	});

	ws.on("close", (code, reason) => {
		console.log("WebSocket client disconnected");
		clients.delete(id); // Remove client from the map
	});

	// Send initial message
	ws.send(JSON.stringify({ type: "info", message: "Connection established" }));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
	console.log(`Listening on port ${port}`);
});
