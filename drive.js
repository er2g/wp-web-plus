/**
 * WhatsApp Web Panel - Google Drive Service v3
 * OAuth2 ile medya yonetimi
 */
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const SHARED_FOLDER_ID = '1ulDoH965gkHDCzUngvPfOJXn6xQ4cRaM';

class DriveService {
    constructor(config) {
        this.drive = null;
        this.oauth2Client = null;
        this.folderId = SHARED_FOLDER_ID;
        this.initialized = false;
        this.authUrl = null;
        this.config = config;
        this.credentialsPath = path.join(config.DATA_DIR, 'drive-oauth-credentials.json');
        this.tokenPath = path.join(config.DATA_DIR, 'drive-token.json');
    }

    /**
     * Drive servisini baslat
     */
    async initialize() {
        if (this.initialized && this.drive) {
            return true;
        }

        if (!fs.existsSync(this.credentialsPath)) {
            console.log('[DRIVE] OAuth credentials not found at:', this.credentialsPath);
            return false;
        }

        try {
            const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
            const { client_id, client_secret } = credentials.installed || credentials.web;

            this.oauth2Client = new google.auth.OAuth2(
                client_id,
                client_secret,
                'http://localhost:3333/oauth2callback'
            );

            // Token varsa yukle
            if (fs.existsSync(this.tokenPath)) {
                const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                this.oauth2Client.setCredentials(token);

                // Token refresh gerekiyorsa
                this.oauth2Client.on('tokens', (tokens) => {
                    if (tokens.refresh_token) {
                        const currentToken = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                        currentToken.refresh_token = tokens.refresh_token;
                        fs.writeFileSync(this.tokenPath, JSON.stringify(currentToken, null, 2));
                    }
                });

                this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
                this.initialized = true;
                console.log('[DRIVE] Initialized with OAuth2, folder:', this.folderId);
                return true;
            } else {
                console.log('[DRIVE] No token found, authorization required');
                return false;
            }
        } catch (error) {
            console.error('[DRIVE] Initialization error:', error.message);
            return false;
        }
    }

    /**
     * Yetkilendirme URL'si al
     */
    getAuthUrl() {
        if (!fs.existsSync(this.credentialsPath)) {
            return null;
        }

        try {
            const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
            const { client_id, client_secret } = credentials.installed || credentials.web;

            const oauth2Client = new google.auth.OAuth2(
                client_id,
                client_secret,
                'http://localhost:3333/oauth2callback'
            );

            return oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: SCOPES,
                prompt: 'consent'
            });
        } catch (error) {
            console.error('[DRIVE] Auth URL error:', error.message);
            return null;
        }
    }

    /**
     * Authorization code ile token al
     */
    async authorize(code) {
        if (!fs.existsSync(this.credentialsPath)) {
            throw new Error('OAuth credentials not found');
        }

        const credentials = JSON.parse(fs.readFileSync(this.credentialsPath, 'utf8'));
        const { client_id, client_secret } = credentials.installed || credentials.web;

        const oauth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            'http://localhost:3333/oauth2callback'
        );

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Token'i kaydet
        fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2));
        console.log('[DRIVE] Token saved');

        this.oauth2Client = oauth2Client;
        this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
        this.initialized = true;

        return true;
    }

    /**
     * Lokal auth server baslat (one-time authorization icin)
     */
    async startAuthServer() {
        return new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                const queryParams = url.parse(req.url, true).query;

                if (queryParams.code) {
                    try {
                        await this.authorize(queryParams.code);
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end('<h1>Basarili!</h1><p>Google Drive yetkilendirmesi tamamlandi. Bu pencereyi kapatabilirsiniz.</p>');
                        server.close();
                        resolve(true);
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end('<h1>Hata!</h1><p>' + error.message + '</p>');
                        server.close();
                        reject(error);
                    }
                } else if (queryParams.error) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Hata!</h1><p>' + queryParams.error + '</p>');
                    server.close();
                    reject(new Error(queryParams.error));
                }
            });

            server.listen(3333, () => {
                console.log('[DRIVE] Auth server listening on http://localhost:3333');
                const authUrl = this.getAuthUrl();
                console.log('[DRIVE] Open this URL to authorize:', authUrl);
            });

            // 5 dakika timeout
            setTimeout(() => {
                server.close();
                reject(new Error('Authorization timeout'));
            }, 300000);
        });
    }

    /**
     * Dosya yukle
     */
    async uploadFile(filePath, mimeType) {
        if (!this.initialized) {
            const success = await this.initialize();
            if (!success) {
                throw new Error('Drive not initialized - authorization required');
            }
        }

        const fileName = path.basename(filePath);

        try {
            const res = await this.drive.files.create({
                requestBody: {
                    name: fileName,
                    parents: [this.folderId]
                },
                media: {
                    mimeType: mimeType || 'application/octet-stream',
                    body: fs.createReadStream(filePath)
                },
                fields: 'id, name, webViewLink, webContentLink'
            });

            // Herkese acik yap
            await this.drive.permissions.create({
                fileId: res.data.id,
                requestBody: {
                    role: 'reader',
                    type: 'anyone'
                }
            });

            const downloadLink = `https://drive.google.com/uc?export=download&id=${res.data.id}`;
            console.log('[DRIVE] Uploaded:', fileName, '->', res.data.id);

            return {
                id: res.data.id,
                name: res.data.name,
                viewLink: res.data.webViewLink,
                downloadLink: downloadLink
            };
        } catch (error) {
            console.error('[DRIVE] Upload error:', error.message);
            throw error;
        }
    }

    /**
     * Mevcut dosyalari tasi
     */
    async migrateExistingFiles(mediaDir, db) {
        if (!this.initialized) {
            const success = await this.initialize();
            if (!success) {
                throw new Error('Drive not initialized');
            }
        }

        const files = fs.readdirSync(mediaDir);
        let migrated = 0;
        let failed = 0;

        console.log('[DRIVE] Starting migration of', files.length, 'files');

        for (const file of files) {
            const filePath = path.join(mediaDir, file);
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;

            try {
                const ext = path.extname(file).toLowerCase();
                const mimeTypes = {
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                    '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
                    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.pdf': 'application/pdf'
                };
                const mimeType = mimeTypes[ext] || 'application/octet-stream';

                const result = await this.uploadFile(filePath, mimeType);

                // DB guncelle
                db.prepare('UPDATE messages SET media_url = ? WHERE media_path = ?')
                    .run(result.downloadLink, filePath);

                // Lokal sil
                fs.unlinkSync(filePath);
                migrated++;

                await new Promise(r => setTimeout(r, 500));
            } catch (error) {
                console.error('[DRIVE] Migration failed for', file, ':', error.message);
                failed++;
            }
        }

        console.log('[DRIVE] Migration complete:', migrated, 'migrated,', failed, 'failed');
        return { migrated, failed };
    }

    /**
     * Durum kontrol
     */
    getStatus() {
        return {
            configured: fs.existsSync(this.credentialsPath),
            authorized: fs.existsSync(this.tokenPath),
            credentialsPath: this.credentialsPath,
            tokenPath: this.tokenPath,
            initialized: this.initialized,
            folderId: this.folderId
        };
    }
}

function createDriveService(config) {
    return new DriveService(config);
}

module.exports = { createDriveService };
