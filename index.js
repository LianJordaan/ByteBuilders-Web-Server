const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser'); // To parse JSON bodies
const Docker = require('dockerode');

const app = express();
const docker = new Docker({ socketPath: '//./pipe/docker_engine' });

var serversList = [];

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
  const { port, plotId } = req.body;

  if (!port || !plotId) {
    return res.status(400).send({ success: false, message: 'port and plotId are required.' });
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
  // Filter server list to only those marked as 'starting'
  const startingPorts = Object.keys(serversList).filter(port => serversList[port].status === 'starting');

  // Check if any servers are still starting by using docker.getContainer and checking the State to be healthy
  for (const port of startingPorts) {
    try {
      const container = docker.getContainer(`dyn-${port}`);
      const status = await container.inspect();
      if (status.State.Health.Status === 'healthy') {
        serversList[port].status = 'running';
      }
    } catch (err) {
      console.error('Error inspecting container:', err);
    }
  }
}

setInterval(checkServerStatuses, 5000);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
