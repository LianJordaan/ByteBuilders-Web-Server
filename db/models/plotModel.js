const mongoose = require('mongoose');

const plotSchema = new mongoose.Schema({
    _id: { type: Number, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true, default: '<!i><white>No description.' },
    bannedPlayers: { type: [String], default: [] },
    whitelistedPlayers: { type: [String], default: [] },
    size: {
        type: Number,
        required: true,
        enum: [128, 256, 512, 1024, 2048, 0] // Allowed numeric values
    },
    sizeName: {
        type: String,
        required: true,
        default: 'Unknown'
    },
    material: { type: String, default: 'map' },
    skullSkin: { type: String, default: '' },
    modelData: { type: Number, default: 0 },
    whitelisted: { type: Boolean, default: false },
    devList: { type: [String], default: [] },
    buildList: { type: [String], default: [] },
    coOwnerList: { type: [String], default: [] },
    ownerUuid: { type: String, required: true },
    // Add other fields as needed
});

const Plot = mongoose.model('Plot', plotSchema);

module.exports = Plot;
