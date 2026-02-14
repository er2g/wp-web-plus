#!/usr/bin/env node
/**
 * Kullanıcı oluşturma CLI scripti.
 *
 * Kullanım:
 *   node scripts/create-user.js --username <kullanici> --password <sifre> [--role admin|agent] [--account default]
 *
 * Örnekler:
 *   node scripts/create-user.js --username admin --password Gizli123 --role admin
 *   node scripts/create-user.js --username user1 --password pass --role agent --account default
 */

/* eslint-disable no-console */
'use strict';

const path = require('path');

// .env dosyasını yükle
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../config');
const { createDatabase } = require('../database');
const { hashPassword } = require('../services/passwords');

function parseArgs() {
    const args = process.argv.slice(2);
    const result = { username: null, password: null, role: 'agent', account: 'default' };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--username') result.username = args[++i];
        else if (args[i] === '--password') result.password = args[++i];
        else if (args[i] === '--role') result.role = args[++i];
        else if (args[i] === '--account') result.account = args[++i];
    }
    return result;
}

async function main() {
    const { username, password, role, account } = parseArgs();

    if (!username || !password) {
        console.error('Hata: --username ve --password zorunludur.');
        console.error('Kullanim: node scripts/create-user.js --username <kullanici> --password <sifre> [--role admin|agent]');
        process.exit(1);
    }

    const accountDataDir = path.join(config.DATA_DIR, 'accounts', account);
    const accountConfig = {
        ...config,
        DATA_DIR: accountDataDir,
        SESSION_DIR: path.join(accountDataDir, 'session'),
        DB_PATH: path.join(accountDataDir, 'whatsapp.db'),
        LOGS_DIR: path.join(accountDataDir, 'logs'),
        MEDIA_DIR: path.join(accountDataDir, 'media'),
    };

    const { mkdirSync } = require('fs');
    mkdirSync(accountDataDir, { recursive: true });

    console.log(`DB yolu: ${accountConfig.DB_PATH}`);
    const db = createDatabase(accountConfig);

    const normalizedUsername = username.trim().toLowerCase();
    const existing = db.users.getByUsername.get(normalizedUsername);
    if (existing) {
        console.log(`Hata: '${normalizedUsername}' kullanicisi zaten mevcut (ID: ${existing.id}).`);
        db.close();
        process.exit(1);
    }

    const targetRole = db.roles.getByName.get(role);
    if (!targetRole) {
        const allRoles = db.roles.getAll.all().map(r => r.name).join(', ');
        console.error(`Hata: '${role}' rolu bulunamadi. Mevcut roller: ${allRoles}`);
        db.close();
        process.exit(1);
    }

    const { salt, hash } = hashPassword(password);
    const result = db.users.create.run(normalizedUsername, username, hash, salt, null, 1, '{}');
    const userId = result.lastInsertRowid;
    db.userRoles.assign.run(userId, targetRole.id);

    console.log(`Kullanici olusturuldu:`);
    console.log(`  ID       : ${userId}`);
    console.log(`  Username : ${normalizedUsername}`);
    console.log(`  Rol      : ${role}`);
    console.log(`  Hesap    : ${account}`);

    db.close();
}

main().catch((err) => {
    console.error('Hata:', err.message);
    process.exit(1);
});
