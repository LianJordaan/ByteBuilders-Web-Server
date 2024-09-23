const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
    uuid: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    favorites: { type: [Number], default: [] },
    lastLogin: { type: Date },
    firstLogin: { type: Date, required: true },
    settings: { type: Map, of: String },
    preferences: { type: Map, of: String },
    tokens: { type: Number },
    bytes: { type: Number },
    plotSizes: {
        128: { type: Number, default: 0 },
        256: { type: Number, default: 0 },
        512: { type: Number, default: 0 },
        1024: { type: Number, default: 0 },
        2048: { type: Number, default: 0 },
        0: { type: Number, default: 0 }
    }
});

const Player = mongoose.model('Player', playerSchema);

module.exports = Player;
