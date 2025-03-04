const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const AWS = require('aws-sdk');
const axios = require('axios');
require('dotenv').config();
const https = require('https');

// Connect to MQTT Broker on Raspberry Pi
const client = mqtt.connect('mqtt://localhost');

// Setup SQLite DB for local storage
const db = new sqlite3.Database('moisture.db');
db.run(`CREATE TABLE IF NOT EXISTS moisture_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id TEXT,
    moisture_level INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Setup WebSocket Server
const wss = new WebSocket.Server({ port: 8080 });
console.log('WebSocket Server running on ws://localhost:8080');

// Connect to AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

// Telegram Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const GABRIEL_CHAT_ID = process.env.GABRIEL_CHAT_ID;
const AMANDA_CHAT_ID = process.env.AMANDA_CHAT_ID;
const MOISTURE_THRESHOLD = 25;
const ALERT_DELAY = 5 * 60 * 1000; // 5 minutes delay before sending an alert

// Store first low moisture reading timestamps
let moistureBelowThresholdSince = {}; // { sensor_id: timestamp }

// Function to send Telegram messages
const sendTelegramMessage = async (message, chatId) => {
    console.log({ chatId });
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: message
        }, {
            httpsAgent: new https.Agent({ rejectUnauthorized: false }) // Disables SSL verification
        });

        console.log(`✅ Telegram alert sent to ${chatId}: ${message}`);
    } catch (error) {
        console.error("❌ Error sending Telegram message:", error.message);
    }
};

// Subscribe to MQTT topic
client.on('connect', () => {
    console.log('Connected to MQTT Broker');
    client.subscribe('sensor/moisture/levels');
});

client.on('message', (topic, message) => {
    const data = JSON.parse(message.toString());
    console.log(`Received: Sensor ${data.sensor_id} - ${data.moisture_level}%`);

    // Save to SQLite
    db.run(`INSERT INTO moisture_data (sensor_id, moisture_level) VALUES (?, ?)`,
        [data.sensor_id, data.moisture_level]);

    // Send real-time update via WebSocket
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });

    const currentTime = Date.now();

    if (data.moisture_level < MOISTURE_THRESHOLD) {
        // If the sensor is under the threshold and wasn't already, mark the first low reading time
        if (!moistureBelowThresholdSince[data.sensor_id]) {
            moistureBelowThresholdSince[data.sensor_id] = currentTime;
        }

        // Check if the moisture level has stayed low for more than the alert delay
        if (currentTime - moistureBelowThresholdSince[data.sensor_id] >= ALERT_DELAY) {
            const alertMessage = `🚨 ALERT: Soil moisture for sensor ${data.sensor_id} is too low! (${data.moisture_level}%)`;

            sendTelegramMessage(alertMessage, GABRIEL_CHAT_ID);
            sendTelegramMessage(alertMessage, AMANDA_CHAT_ID);

            // Reset the alert timer to prevent spamming until the moisture level rises again
            moistureBelowThresholdSince[data.sensor_id] = null;
        }
    } else {
        // If moisture level is back to normal, reset the low reading timestamp
        if (moistureBelowThresholdSince[data.sensor_id]) {
            console.log(`✅ Moisture for sensor ${data.sensor_id} is back to normal.`);
        }
        moistureBelowThresholdSince[data.sensor_id] = null;
    }
});

// Function to upload data to S3 every hour
setInterval(() => {
    db.all("SELECT * FROM moisture_data", [], (err, rows) => {
        if (err) throw err;
        const fileContent = JSON.stringify(rows);

        const params = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: `moisture-data-${Date.now()}.json`,
            Body: fileContent,
            ContentType: "application/json"
        };

        s3.upload(params, (err, data) => {
            if (err) console.error("Error uploading to S3:", err);
            else console.log("Uploaded to S3:", data.Location);

            // Clear old records after upload
            db.run("DELETE FROM moisture_data");
        });
    });
}, 3600000); // Every 1 hour