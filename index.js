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
const resolveUUID = require('./resolveUUID');
const dbManagement = require('./db/dbManagement');
const { type } = require("os");
const Player = require("./db/models/playerModel");

const IDLE_SERVER_COUNT = 1;
const plotsPerRank = {
	"default": {
		"128": 2,
		"256": 1,
		"512": 0,
		"1024": 0,
		"2048": 0,
		"0": 0
	},
	"noble": {
		"128": 2,
		"256": 2,
		"512": 0,
		"1024": 0,
		"2048": 0,
		"0": 0
	},
	"mythic": {
		"128": 3,
		"256": 2,
		"512": 1,
		"1024": 0,
		"2048": 0,
		"0": 0
	},
	"emperor": {
		"128": 4,
		"256": 3,
		"512": 2,
		"1024": 1,
		"2048": 0,
		"0": 0
	},
	"royal": {
		"128": 5,
		"256": 4,
		"512": 3,
		"1024": 2,
		"2048": 1,
		"0": 0
	},
	"media": {
		"128": 5,
		"256": 4,
		"512": 3,
		"1024": 2,
		"2048": 1,
		"0": 1
	},
}

const plotSizeToName = {
	"128": "Small",
	"256": "Basic",
	"512": "Large",
	"1024": "Massive",
	"2048": "Mega",
	"0": "Super"
}

const orderedSizes = ["128", "256", "512", "1024", "2048", "0"];

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

app.post('/player/get-plots', async (req, res) => {
    const { uuid } = req.body;

    if (!uuid) {
        return res.status(400).json({ error: 'UUID is required' });
    }

    try {
        // Check if the player exists in the database
        const player = await dbManagement.playerExistsByUuid(uuid);

        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }

		const plots = await dbManagement.getAllPlotsByPlayer(uuid);
		const plotCounts = {};

		for (let i = 0; i < orderedSizes.length; i++) {
			const key = orderedSizes[i];
			plotCounts[plotSizeToName[key]] = 0; // Initialize with 0 for each plot size
		}
		

		for (const plot of plots) {
			plotCounts[plotSizeToName[plot.size.toString()]] += 1;
		}

		const json = {
			plots: plots,
			plotCounts: plotCounts
		}

        return res.json(json);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/player/get-limits', async (req, res) => {
    const { uuid, rank } = req.body;

    // Validate input
    if (!uuid || !rank) {
        return res.status(400).json({ error: 'UUID and rank are required' });
    }

    try {
        // Check if the player exists in the database
        const playerExists = await dbManagement.playerExistsByUuid(uuid);

        if (!playerExists) {
            return res.status(404).json({ error: 'Player not found' });
        }

        const player = await dbManagement.getPlayerByUuid(uuid);

        // Get all plots owned by the player
        const playerPlots = await dbManagement.getAllPlotsByPlayer(uuid);

        // Calculate available plot limits based on the player's rank
        const limitsForRank = plotsPerRank[rank.toLowerCase()];

        if (!limitsForRank) {
            return res.status(400).json({ error: 'Invalid rank specified' });
        }

        // Initialize remaining and used plot counts
        let availablePlots = { ...limitsForRank };

        Object.entries(player.plotSizes).forEach(([size]) => {
            availablePlots[size] = (availablePlots[size] || 0) + player.plotSizes[size];
        });

        let usedPlots = {};

        // Loop through player's plots and adjust available plot slots
        playerPlots.forEach(plot => {
            const plotSize = plot.size.toString();
            if (availablePlots[plotSize] !== undefined) {
                availablePlots[plotSize] = Math.max(availablePlots[plotSize] - 1, 0);
                usedPlots[plotSize] = (usedPlots[plotSize] || 0) + 1;
            }
        });

        // Prepare response object using orderedSizes
        let responseJson = {};
        for (const size of orderedSizes) {
            const plotSizeName = plotSizeToName[size];
            const limit = availablePlots[size] || 0;
            responseJson[plotSizeName] = {
                max: limitsForRank[size] + player.plotSizes[size],
                used: usedPlots[size] || 0,
                remaining: limit,
                sizeName: size === "0" ? "Infinite" : size + "x" + size,
				size: size,
            };
        }

        return res.json(responseJson);

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/player/login', async (req, res) => {
    const { uuid, username } = req.body;

    if (!uuid || !username) {
        return res.status(400).json({ error: 'UUID and username are required' });
    }

    try {
        // Check if the player already exists in the database
        const player = await dbManagement.playerExistsByUuid(uuid); // Correct usage of `uuid`

        if (player) {
			let newPlayerData = await dbManagement.getPlayerByUuid(uuid);
            // Player exists, check if the username needs to be updated
            newPlayerData.username = username;
            newPlayerData.lastLogin = new Date();
            await dbManagement.updatePlayer(uuid, newPlayerData);
            console.log(`Updated player ${uuid} with new username: ${username}`);
        } else {
            // Player does not exist, create a new one
            const newPlayer = new Player({
                uuid: uuid, // Correct usage of `uuid`
                username: username,
                firstLogin: new Date(),
                lastLogin: new Date(),
                // Set other default fields if needed
            });
            await newPlayer.save();
            console.log(`Created new player ${uuid} with username: ${username}`);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error(`Error handling player data: ${error}`);
        return res.status(500).json({ error: 'Error processing player data' });
    }
});

app.delete("/delete-plot", async (req, res) => {
	const { plotId, uuid, bypass } = req.body;
	if (!plotId) {
		return res.status(400).send({ success: false, message: "plotId is required." });
	}

	const plotExists = await dbManagement.plotExistsById(plotId);
    if (!plotExists) {
        return res.status(404).send({ success: false, message: "Plot does not exist." });
    }

	for (const port of Object.keys(serversList)) {
		if (serversList[port].status === "running" && serversList[port].plotId == plotId) {
			return res.status(409).send({ success: false, port: port, message: "Server is running. Stop the server before deleting the plot." });
		}
	}

	try {
		let plot = await dbManagement.getPlotById(plotId);
		if (plot.ownerUuid !== uuid) {
			if (!bypass)	{
				return res.status(403).send({ success: false, message: "You do not have permission to delete this plot." });
			}
		}
		await dbManagement.deletePlot(plotId);
		try {
			fs.rmSync(path.join(__dirname, 'data', `plot-${plotId}`), { recursive: true }); 
		} catch (error) {
		}
		return res.status(200).send({ success: true, message: "Plot deleted successfully.", id: plotId });
	} catch (error) {
		console.error("Error deleting plot:", error);
		return res.status(500).send({
			success: false,
			message: "Failed to delete plot.",
		});
	}
});

app.post("/create-plot", async (req, res) => {
	const { name, description, size, ownerUuid, rank } = req.body;

	console.log(req.body);

	if (!name || (!size && size.toString() !== '0') || !ownerUuid || !rank) {
		return res.status(400).send({ success: false, message: "name, size, ownerUuid, and rank are required." });
	}
	const allowedSizes = ['128', '256', '512', '1024', '2048', '0'];
	if (!allowedSizes.includes(size.toString())) {
		return res.status(400).send({ success: false, message: `Invalid size value. Allowed values are ${allowedSizes.join(', ')}.` });
	}

	let maxPlotsOfType = plotsPerRank[rank][size];
	const playerObject = await dbManagement.getPlayerByUuid(ownerUuid);
	maxPlotsOfType += playerObject.plotSizes[size];

	let ownedPlotsOfType = 0;

	const ownedPlots = await dbManagement.getAllPlotsByPlayer(ownerUuid);
	for (const plot of ownedPlots) {
		if (plot.size == size) {
			ownedPlotsOfType += 1;
		}
	}

	if (ownedPlotsOfType >= maxPlotsOfType) {
		return res.status(400).send({ success: false, message: `You already own the maximum number of plots of this type.`, shortMessage: "limit_reached", plotType: plotSizeToName[size.toString()] });
	}

	const plotId = await dbManagement.findFirstUnusedPlotId();
	const plotData = {
		name,
		description,
		size,
		sizeName: plotSizeToName[size.toString()], 
		ownerUuid,
		_id: plotId,
	};
	try {
		const plot = await dbManagement.createPlot(plotData);
		return res.status(201).send({ success: true, message: "Plot created successfully.", id: plot.id });
	} catch (error) {
		console.error("Error creating plot:", error);
		return res.status(500).send({ success: false, message: "Failed to create plot." });
	}
});

app.post("/start-server", async (req, res) => {
    const { id } = req.body;

    if (!id) {
        return res.status(400).send({ success: false, message: "id is required." });
    }

	const plotExists = await dbManagement.plotExistsById(id);
	if (!plotExists) {
		return res.status(410).send({ success: false, port: port, message: "Plot already exists." });
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
			const websocketOfServer = clients.get(port);
			const container = docker.getContainer(`dyn-${port}`);
			await container.update({
				// Default to 300% of CPU Core
				CpuQuota: 30000, // 30,000 microseconds
				CpuPeriod: 10000, // 10,000 microseconds
			});

			const serverDataZipFilePath = path.join(__dirname, 'data', `plot-${id}`, 'data.zip');

			if (fs.existsSync(serverDataZipFilePath)) {
				
				// await sendActionAndWaitForResponse(websocketOfServer, "unload-worlds");
				// await sendActionAndWaitForResponse(websocketOfServer, "unload-plugins");
				
				await restoreFilesToContainer(container, port, id);
				
			} else {
				console.log(`No zip file found for container dyn-${port}. Skipping restore.`);
			}

			const plot = await dbManagement.getPlotById(id);
			websocketOfServer.send(
				JSON.stringify({
					type: "action",
					action: "set-size",
					size: plot.size
				})
			);
			await sendActionAndWaitForResponse(websocketOfServer, "load-worlds");
		
			// websocketOfServer.send(
			// 	JSON.stringify({
			// 		type: "action",
			// 		action: "load-plugins",
			// 	})
			// );

			await container.update({
				// Default to 50% of CPU Core
				CpuQuota: 500000, // 5,000 microseconds
				CpuPeriod: 10000, // 10,000 microseconds
			});

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
                Memory: 3 * 1024 * 1024 * 1024, // 3 GB
				MemorySwap: 3 * 1024 * 1024 * 1024, // 3 GB
				MemorySwappiness: 100, // 100% prever swap
                CpuQuota: 30000, // 30,000 microseconds
                CpuPeriod: 10000, // 10,000 microseconds
				OomKillDisable: true, // Disable OOM Killer
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
        console.log(`Less than ${IDLE_SERVER_COUNT} servers without an ID found. Starting a new one...`);
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
                Memory: 3 * 1024 * 1024 * 1024, // 3 GB
				MemorySwap: 3 * 1024 * 1024 * 1024, // 3 GB
				MemorySwappiness: 100, // 100% prever swap
                CpuQuota: 30000, // 30,000 microseconds
                CpuPeriod: 10000, // 10,000 microseconds
				OomKillDisable: true, // Disable OOM Killer
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

const execPromise = util.promisify(exec);

async function copyFilesFromContainer(container, port) {
    // Inspect the container to get detailed information
    const data = await container.inspect();
    const containerName = data.Name.substring(1);  // Remove leading '/'

    const containerPaths = [
        "/minecraft/dim-code/",
        "/minecraft/dim-play/",
        "/minecraft/plugins/Skript/scripts/",
        "/minecraft/vars.json",
        "/minecraft/data.json"
    ];

    const tempFolder = path.join(__dirname, 'temp', `dyn-${port}`);
    fs.mkdirSync(tempFolder, { recursive: true });

    for (const containerPath of containerPaths) {
        try {
            // Determine local path based on container path
            let localPath;
            if (containerPath.endsWith('/')) {
                // If it's a directory, create the corresponding directory in tempFolder
                localPath = path.join(tempFolder, containerPath.replace(/^\/minecraft\//, ''));
                fs.mkdirSync(localPath, { recursive: true });
            } else {
                // If it's a file, create the directory path and copy the file
                localPath = path.join(tempFolder, containerPath.replace(/^\/minecraft\//, ''));
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
            }

			const newLocalPath = localPath.slice(0, -1);
			const lastSlashIndex = newLocalPath.lastIndexOf('\\');
			const result = newLocalPath.slice(0, lastSlashIndex);

            // Run the cp command to copy files from container to the host
            await execPromise(`docker cp ${containerName}:"${containerPath}" "${result}"`);

            console.log(`Copied ${containerPath} from container ${containerName} to ${result}.`);
        } catch (error) {
            console.log(`Error copying ${containerPath}: ${error.message}. Skipping...`);
        }
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
    archive.directory(tempFolder, false);

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

// Graceful shutdown handler
function gracefulShutdown(signal) {
    console.log(`${signal} signal received: sending shutdown message to clients`);

    // Send a shutdown message to all connected clients
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'shutdown', delay: 5, attempts: 3 }));
        }
    });

    // Wait for a few seconds to allow clients to disconnect
    setTimeout(() => {
        console.log('Closing HTTP server and other connections');
        saveServerInfo(); // Implement your saving logic here
        process.exit(0); // Exit after cleanup
    }, 0); // 5 seconds delay before shutdown
}

// Graceful shutdown handling for SIGTERM and SIGINT
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
						json: parsedMessage.data,
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
									CpuQuota: 500000, // 5,000 microseconds
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

			if (parsedMessage.type === "request-file") {
				if (parsedMessage.worldName && parsedMessage.file && parsedMessage.fileType && parsedMessage.fileType === "world") {
					const sourceFilePath = path.join(__dirname, 'files', 'worlds', parsedMessage.file);
					const tempContainerPath = `/minecraft/`;
					const finalContainerPath = `/minecraft/${parsedMessage.worldName}/`;
		
					if (fs.existsSync(sourceFilePath)) {
						try {
		
							// Copy the file from the host to the Docker container
							await execPromise(`docker cp "${sourceFilePath}" dyn-${id}:"${tempContainerPath}"`);
		
							// Rename the directory inside the container
							await execPromise(`docker exec dyn-${id} mv ${tempContainerPath}${parsedMessage.file} ${finalContainerPath}`);

							console.log(`Copied ${sourceFilePath} to container dyn-${id} at ${finalContainerPath}.`);
							// send a response to satisfy these conditions
							// (jsonResponse.get("type").equals("response") &&
                            //     jsonResponse.get("status").equals("world-transfer-complete") &&
                            //     jsonResponse.get("world").equals("play-void")) {
							ws.send(JSON.stringify({ type: "response", status: "world-transfer-complete", world: parsedMessage.worldName }));
						} catch (error) {
							console.log(`Error processing file ${sourceFilePath} in container dyn-${id}: ${error.message}. Skipping...`);
						}
					} else {
						console.log(`File ${sourceFilePath} does not exist. Skipping...`);
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

// Register the endpoint
app.get('/resolve-uuid', resolveUUID);

const port = process.env.PORT || 3000;
server.listen(port, () => {
	console.log(`Listening on port ${port}`);
});
