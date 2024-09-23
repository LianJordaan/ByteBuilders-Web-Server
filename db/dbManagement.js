const mongoose = require('mongoose');
const Plot = require('./models/plotModel'); // Import your Plot model
const Player = require('./models/playerModel'); // Import your Player model

// Connect to MongoDB
const uri = 'mongodb://192.168.0.125:27017/bytebuilders';
mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));

// Function to get player data by UUID
async function getPlayerByUuid(uuid) {
    try {
        const player = await Player.findOne({ uuid });
        if (!player) throw new Error('Player not found');
        return player;
    } catch (error) {
        throw new Error('Error retrieving player: ' + error.message);
    }
}

// Function to see if a player exists by UUID
async function playerExistsByUuid(uuid) {
    try {
        const player = await Player.findOne({ uuid });
        return player !== null;
    } catch (err) {
        console.error('Error checking player existence by UUID:', err);
        return false;
    }
}

// Function to update player data using uuid instead of id
async function updatePlayer(playerUuid, updateData) {
    try {
        const player = await Player.findOneAndUpdate({ uuid: playerUuid }, updateData, { new: true });
        if (!player) throw new Error('Player not found');
        return player;
    } catch (error) {
        throw new Error('Error updating player: ' + error.message);
    }
}

// Function to create a new player
async function createPlayer(playerData) {
    try {
        const player = new Player(playerData);
        await player.save();
        return player;
    } catch (error) {
        throw new Error('Error creating player: ' + error.message);
    }
}

// Function to create a new plot
async function createPlot(plotData) {
    try {
        const plot = new Plot(plotData);
        await plot.save();
        return plot;
    } catch (error) {
        throw new Error('Error creating plot: ' + error.message);
    }
}

// Function to get all plots from a certain player uuid
async function getAllPlotsByPlayer(playerUuid) {
    try {
        const plots = await Plot.find({ ownerUuid: playerUuid });
        return plots;
    } catch (error) {
        throw new Error('Error retrieving plots: ' + error.message);
    }
}

// Function to get all plots
async function getAllPlots() {
    try {
        const plots = await Plot.find();
        return plots;
    } catch (error) {
        throw new Error('Error retrieving plots: ' + error.message);
    }
}

// Function to get a plot by ID
async function getPlotById(plotId) {
    try {
        const plot = await Plot.findById(plotId);
        if (!plot) throw new Error('Plot not found');
        return plot;
    } catch (error) {
        throw new Error('Error retrieving plot: ' + error.message);
    }
}

// Function to update a plot by ID
async function updatePlot(plotId, updateData) {
    try {
        const plot = await Plot.findByIdAndUpdate(plotId, updateData, { new: true });
        if (!plot) throw new Error('Plot not found');
        return plot;
    } catch (error) {
        throw new Error('Error updating plot: ' + error.message);
    }
}

// Function to delete a plot by ID
async function deletePlot(plotId) {
    try {
        const result = await Plot.findByIdAndDelete(plotId);
        if (!result) throw new Error('Plot not found');
        return { message: 'Plot deleted successfully' };
    } catch (error) {
        throw new Error('Error deleting plot: ' + error.message);
    }
}

// Function to check if a plot exists by ID
const plotExistsById = async (id) => {
    try {
        const plot = await Plot.findById(id);
        return plot !== null;
    } catch (err) {
        console.error('Error checking plot existence by ID:', err);
        return false;
    }
};

// Function to check if a plot exists by a unique field (e.g., plotName)
const plotExistsByField = async (fieldName, value) => {
    try {
        const query = {};
        query[fieldName] = value;
        const plot = await Plot.findOne(query);
        return plot !== null;
    } catch (err) {
        console.error(`Error checking plot existence by field ${fieldName}:`, err);
        return false;
    }
};

/**
 * Finds the first unused plot ID.
 * @returns {Promise<number>} The first unused plot ID.
 */
async function findFirstUnusedPlotId() {
    try {
        // Find all existing plot IDs
        const plots = await Plot.find({}, '_id').sort({ _id: 1 }).exec();

        // Initialize the ID to check
        let nextId = 1;

        // Iterate through existing IDs to find the first gap
        for (const plot of plots) {
            if (plot._id !== nextId) {
                // If there's a gap, return the first missing ID
                return nextId;
            }
            nextId++;
        }

        // If no gap is found, return the next consecutive ID
        return nextId;
    } catch (error) {
        console.error('Error finding first unused plot ID:', error);
        throw error;
    }
}

// Export functions
module.exports = {
    createPlot,
    getAllPlots,
    getPlotById,
    updatePlot,
    deletePlot,
    plotExistsById,
    plotExistsByField,
	findFirstUnusedPlotId,
	getPlayerByUuid,
	playerExistsByUuid,
	updatePlayer,
	createPlayer,
    getAllPlotsByPlayer,
};
