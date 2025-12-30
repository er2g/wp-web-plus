module.exports = {
    root: true,
    env: {
        es2021: true,
        node: true
    },
    extends: [
        'eslint:recommended'
    ],
    parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'script'
    },
    ignorePatterns: [
        'node_modules/',
        'data/',
        'logs/',
        '.wwebjs_cache/'
    ],
    rules: {
        'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'no-empty': ['error', { allowEmptyCatch: true }]
    },
    overrides: [
        {
            files: ['public/**/*.js'],
            env: {
                browser: true,
                es2021: true
            }
        },
        {
            files: ['test/**/*.js'],
            env: {
                node: true,
                es2021: true
            }
        }
    ]
};
