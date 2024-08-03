const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser'); // To parse JSON bodies
const Docker = require('dockerode');

const app = express();
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });

var serversList = {};
loadServerInfo();

// Middleware to parse JSON bodies
app.use(bodyParser.json());
app.use(express.json()); // Make sure you can parse JSON request bodies

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/list-plots', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const plotStatuses = await Promise.all(containers.map(async (container) => {
      const containerObj = docker.getContainer(container.Id);
      const data = await containerObj.inspect();
      return {
        id: container.Id,
        name: container.Names[0],
        status: data.State.Running
      };
    }));

    res.send({ success: true, message: 'List of plots', plotStatuses });
  } catch (err) {
    console.error('Error listing plots:', err);
    res.status(500).send({ success: false, message: 'Failed to list plots.' });
  }
});


app.get('/plot-status', async (req, res) => {
	const { port } = req.query;

	if (!port) {
		return res.status(400).send({ success: false, message: 'port is required.' });
	}

	try {
		const container = docker.getContainer(`dyn-${port}`); 
		const status = await container.inspect();
		res.send({ success: true, message: 'Plot status', status });
	} catch (err) {
		console.error('Error getting container status:', err);
		res.status(500).send({ success: false, message: 'Failed to get container status.' });
	}
});

app.post('/start-server', async (req, res) => {
  const { port } = req.body;

  if (!port) {
    return res.status(400).send({ success: false, message: 'port is required.' });
  }

  try {
    // Define the image and container name
    const imageName = 'minecraft-server'; // Use your Docker image name
    const containerName = `dyn-${port}`;

    // Create and start the container
    const container = await docker.createContainer({
      Image: imageName,
      name: containerName,
      ExposedPorts: { [`${port}/tcp`]: {} },
      HostConfig: {
        PortBindings: {
          [`${port}/tcp`]: [{ HostPort: port }],
        },
        AutoRemove: true,

        Memory: 2 * 1024 * 1024 * 1024, // 2 GB
        CpuQuota: 30000,  // 30,000 microseconds
        CpuPeriod: 10000 // 10,000 microseconds
        
      },
      Env: [`PORT=${port}`], // Pass the port as an environment variable
    });

    // Start the container
    await container.start();

    serversList[port] = { plotId: null, status: 'starting' };

    // Send response once everything is done
    res.send({ success: true, message: `Container ${containerName} started on port ${port}.` });
  } catch (err) {
    console.error('Error starting container:', err);
    res.status(500).send({ success: false, message: 'Failed to start container.' });
  }
});

app.get('/list-server-statuses', async (req, res) => {
  let statusObject = {};
  for (const port of Object.keys(serversList)) {
    const server = serversList[port];
    statusObject[port] = {
      status: server.status,
      plotId: server.plotId
    };
  }
  res.send(statusObject);
});

app.post('/stop-server', async (req, res) => {
  const { port } = req.body;

  if (!port) {
    return res.status(400).send({ success: false, message: 'port is required.' });
  }

  try {
    const container = docker.getContainer(`dyn-${port}`);
    await container.stop();
    res.send({ success: true, message: `Container dyn-${port} stopped.` });
  } catch (err) {
    console.error('Error stopping container:', err);
    res.status(500).send({ success: false, message: 'Failed to stop container.' });
  }
});

async function checkServerStatuses() {
  // Iterate through all servers in the list
  for (const port of Object.keys(serversList)) {
    const server = serversList[port];
    
    try {
      const container = docker.getContainer(`dyn-${port}`);
      const status = await container.inspect();

      if (server.status === 'starting') {
        // Check if the server in 'starting' status is healthy
        if (status.State.Health.Status === 'healthy') {
          // Update the server status to 'running'
          server.status = 'running';
          
          // Update CPU limits
          await container.update({ // Default to 50% of CPU Core
            CpuQuota: 5000,  // 5,000 microseconds
            CpuPeriod: 10000 // 10,000 microseconds
          });
          console.log(`Server dyn-${port} updated with CPU limits.`);
        }
      } else if (server.status === 'running') {
        // Check if the server in 'running' status is still healthy
        if (status.State.Status === 'running' && status.State.Health && status.State.Health.Status === 'healthy') {
          // Container is healthy and running; no action needed here
        } else {
          console.log(`Server dyn-${port} is not healthy or not running.`);
          // Stop the container if it is still running
          if (status.State.Status === 'running') {
            await container.stop();
            console.log(`Stopped container dyn-${port}.`);
          }
          // Update server status to 'stopped' and remove from the list
          server.status = 'stopped';
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
        console.error('Error inspecting container:', err);
      }
    }
  }
}

setInterval(checkServerStatuses, 5000);

function saveServerInfo() {
  fs.writeFileSync('serverInfo.json', JSON.stringify(serversList, null, 2), 'utf-8');
  console.log('Server info saved to serverInfo.json');
}

function loadServerInfo() {
  try {
    const data = fs.readFileSync('serverInfo.json', 'utf-8');
    serversList = JSON.parse(data);
    console.log('Server info loaded from serverInfo.json');
  } catch (err) {
    console.error('Error loading server info:', err);
    // Initialize serversList as an empty object if the file does not exist
    serversList = {};
  }
}

// Graceful shutdown handler to save server info
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  saveServerInfo();
  // Close other connections and cleanup...
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  saveServerInfo();
  // Close other connections and cleanup...
  process.exit(0);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
