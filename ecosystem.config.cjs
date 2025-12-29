module.exports = {
    apps: [
        {
            name: 'whatsapp-panel',
            script: 'server.js',
            exec_mode: 'fork',
            instances: 1,
            max_memory_restart: '512M',
            env: {
                NODE_ENV: 'development',
                ENABLE_BACKGROUND_JOBS: 'true',
                LOG_LEVEL: 'info'
            },
            env_production: {
                NODE_ENV: 'production',
                ENABLE_BACKGROUND_JOBS: 'true',
                LOG_LEVEL: 'info'
            }
        }
    ]
};

