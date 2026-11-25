const path = require("node:path");

module.exports = {
  apps: [{
    name: "notify-relay-bot-scheduler",
    cwd: path.resolve(__dirname, ".."),
    script: "dist/pm2-scheduler.js",
    interpreter: process.execPath,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    wait_ready: true,
    listen_timeout: 10000,
    restart_delay: 3000,
    // An in-flight send keeps its run-task lock and may finish across a scheduler restart.
    treekill: false,
    time: true,
  }],
};
