const axios = require('axios');
const fs = require('fs');

let cache = {};
try {
    const data = fs.readFileSync('cache.json', 'utf8');
    cache = JSON.parse(data);
} catch (err) {
    console.log('No cache file found, starting with an empty cache.');
}

// Function to save the cache to a file
const saveCache = () => {
    fs.writeFileSync('cache.json', JSON.stringify(cache, null, 2), 'utf8');
};

// Function to resolve UUID using axios
const resolveUUID = async (req, res) => {
    const username = req.query.username;

    if (!username) {
        return res.status(400).json({ error: 'No username provided' });
    }

    // Check if username is already in cache
    if (cache[username]) {
        console.log(`Cache hit for ${username}`);
        return res.json({ username, uuid: cache[username] });
    }

    console.log(`Cache miss for ${username}, requesting from custom API...`);

    try {
        const response = await axios.get(`https://playerdb.co/api/player/minecraft/${username}`);

        const jsonResponse = response.data;

        if (jsonResponse.success && jsonResponse.code === "player.found") {
            const uuid = jsonResponse.data.player.id;
            cache[username] = uuid;
            saveCache();
            return res.json({ username, uuid });
        } else {
            return res.status(404).json({ error: 'Username not found' });
        }
    } catch (error) {
        console.error(`Error fetching UUID from custom API: ${error}`);
        return res.status(500).json({ error: 'Error fetching UUID from custom API' });
    }
};

// Function to handle server shutdown and save the cache
const shutdownServer = (req, res) => {
    saveCache();
    console.log('Cache saved on shutdown.');
    res.status(200).json({ message: 'Cache saved successfully.' });
};

module.exports = { resolveUUID, shutdownServer };
