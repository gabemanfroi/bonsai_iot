const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const AWS = require('aws-sdk');
require('dotenv').config();

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
