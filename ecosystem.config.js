module.exports = {
  apps: [{
    name: "mybot",
    script: "index.js",
    watch: true,
    ignore_watch: ["node_modules", ".botlock"],
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    }
  }]
}