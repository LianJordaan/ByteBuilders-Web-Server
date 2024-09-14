const axios = require('axios');
const fs = require('fs');

// Cache expiration time in milliseconds (e.g., 24 hours)
const CACHE_EXPIRATION_TIME = 24 * 60 * 60 * 1000;

// Load cache from the file or initialize an empty object
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

// Function to clean expired entries from the cache
const cleanExpiredCache = () => {
    const now = Date.now();
    for (const [uuid, data] of Object.entries(cache)) {
        if (now - data.timestamp > CACHE_EXPIRATION_TIME) {
            delete cache[uuid];
        }
    }
    saveCache();
};

// Function to resolve UUID using axios
const resolveUUID = async (req, res) => {
    const username = req.query.username;

    if (!username) {
        return res.status(400).json({ error: 'No username provided' });
    }

    // Clean expired cache entries
    cleanExpiredCache();

    // Check if the UUID is already in the cache by username
    const cachedEntry = Object.entries(cache).find(([uuid, data]) => data.username.toLowerCase() === username.toLowerCase());
    if (cachedEntry) {
        const [uuid, data] = cachedEntry;
        console.log(`Cache hit for ${username} with UUID ${uuid}`);
        return res.json({ username: data.username, uuid });
    }

    console.log(`Cache miss for ${username}, requesting from custom API...`);

    try {
        const response = await axios.get(`https://playerdb.co/api/player/minecraft/${username}`);
        const jsonResponse = response.data;

        if (jsonResponse.success && jsonResponse.code === "player.found") {
            const uuid = jsonResponse.data.player.id;
            const resolvedUsername = jsonResponse.data.player.username; // Fetch the latest username from the response

            // Cache by UUID to username with timestamp
            cache[uuid] = { username: resolvedUsername, timestamp: Date.now() };
            saveCache();
            return res.json({ username: resolvedUsername, uuid });
        } else {
            return res.status(404).json({ error: 'Username not found' });
        }
    } catch (error) {
        console.error(`Error fetching UUID from custom API: ${error}`);
        return res.status(500).json({ error: 'Error fetching UUID from custom API' });
    }
};

module.exports = resolveUUID;
