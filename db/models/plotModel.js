const mongoose = require('mongoose');

const plotSchema = new mongoose.Schema({
    _id: { type: Number, required: true },
    name: { type: String, required: true },
    bannedPlayers: { type: [String], default: [] },
    whitelistedPlayers: { type: [String], default: [] },
    size: {
        type: Number,
        required: true,
        enum: [128, 256, 512, 1024, 2048, 0] // Allowed numeric values
    },
    icon: { type: String, default: 'map' },
    devList: { type: [String], default: [] },
    buildList: { type: [String], default: [] },
    coOwnerList: { type: [String], default: [] },
    ownerUuid: { type: String, required: true },
    // Add other fields as needed
});

const Plot = mongoose.model('Plot', plotSchema);

module.exports = Plot;
