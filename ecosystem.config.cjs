module.exports = {
    apps: [
        {
            name: 'whatsapp-panel',
            script: 'server.js',
            exec_mode: 'fork',
            instances: 1,
            max_memory_restart: '512M',
            shutdown_with_message: true,
            kill_timeout: 15000,
            min_uptime: 5000,
            max_restarts: 10,
            restart_delay: 1000,
            time: true,
            env: {
                NODE_ENV: 'development',
                ENABLE_BACKGROUND_JOBS: 'true',
                LOG_LEVEL: 'info',
                SHUTDOWN_TIMEOUT_MS: '10000'
            },
            env_production: {
                NODE_ENV: 'production',
                ENABLE_BACKGROUND_JOBS: 'true',
                LOG_LEVEL: 'info',
                SHUTDOWN_TIMEOUT_MS: '10000'
            }
        }
    ]
};
