const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const db = require('./database');

// Configure autoUpdater
autoUpdater.autoDownload = false; // We want to show a button first
autoUpdater.autoInstallOnAppQuit = true;

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false, // Don't show until content is ready
        backgroundColor: '#ffffff', // Match splash screen background to avoid flash
        icon: path.join(__dirname, 'src/assets/app-logo.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Only show the window after contente is fully painted
    win.once('ready-to-show', () => {
        win.maximize();
        win.show();
    });

    if (app.isPackaged) {
        win.loadFile(path.join(__dirname, 'dist/index.html'));
    } else {
        win.loadURL('http://localhost:3000').catch(() => {
            console.log('Dev server not available, loading from local file...');
            win.loadFile('index.html');
        });
        win.webContents.openDevTools();
    }

    // Auto-updater events to send to renderer
    autoUpdater.on('checking-for-update', () => {
        win.webContents.send('update-message', 'Checking for update...');
    });
    autoUpdater.on('update-available', (info) => {
        win.webContents.send('update-available', info);
    });
    autoUpdater.on('update-not-available', (info) => {
        win.webContents.send('update-message', 'App is up to date.');
    });
    autoUpdater.on('error', (err) => {
        win.webContents.send('update-error', err.message);
    });
    autoUpdater.on('download-progress', (progressObj) => {
        win.webContents.send('download-progress', progressObj);
    });
    autoUpdater.on('update-downloaded', (info) => {
        win.webContents.send('update-downloaded', info);
    });

    // Check for updates automatically on startup
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify();
    }
}

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();

    // Auto Update IPCs
    ipcMain.handle('check-for-updates', () => {
        if (!app.isPackaged) {
            return { message: 'Cannot check for updates in development mode.' };
        }
        autoUpdater.checkForUpdatesAndNotify();
        return { message: 'Checking for updates...' };
    });

    ipcMain.handle('start-download', () => {
        autoUpdater.downloadUpdate();
        return { message: 'Starting download...' };
    });

    ipcMain.handle('install-update', () => {
        autoUpdater.quitAndInstall();
    });

    // ... existing IPC handlers ...
    ipcMain.handle('get-users', () => {
        return db.prepare('SELECT * FROM users').all();
    });

    ipcMain.handle('add-user', (event, user) => {
        const stmt = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
        return stmt.run(user.name, user.email);
    });

    ipcMain.handle('get-test-templates', () => {
        return db.prepare('SELECT * FROM test_templates ORDER BY created_at DESC').all();
    });

    ipcMain.handle('add-test-template', (event, template) => {
        const stmt = db.prepare('INSERT INTO test_templates (name, items) VALUES (?, ?)');
        return stmt.run(template.name, JSON.stringify(template.items));
    });

    ipcMain.handle('update-test-template', (event, template) => {
        const stmt = db.prepare('UPDATE test_templates SET name = ?, items = ? WHERE id = ?');
        return stmt.run(template.name, JSON.stringify(template.items), template.id);
    });

    ipcMain.handle('delete-test-template', (event, id) => {
        const stmt = db.prepare('DELETE FROM test_templates WHERE id = ?');
        return stmt.run(id);
    });

    ipcMain.handle('get-reports', () => {
        try {
            return db.prepare('SELECT id, patient_name, patient_id, report_data, created_at FROM reports ORDER BY created_at DESC').all();
        } catch (err) {
            console.error('Error fetching reports:', err);
            throw err;
        }
    });

    ipcMain.handle('get-report-by-id', (event, id) => {
        try {
            return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
        } catch (err) {
            console.error('Error fetching report by ID:', err);
            throw err;
        }
    });

    ipcMain.handle('save-report', (event, report) => {
        try {
            const stmt = db.prepare('INSERT INTO reports (patient_name, patient_id, report_data) VALUES (?, ?, ?)');
            const result = stmt.run(report.patient_name, report.patient_id, JSON.stringify(report.report_data));
            return { success: true, id: result.lastInsertRowid };
        } catch (err) {
            console.error('Error saving report:', err);
            throw err;
        }
    });

    ipcMain.handle('update-report', (event, report) => {
        try {
            const stmt = db.prepare('UPDATE reports SET patient_name = ?, patient_id = ?, report_data = ? WHERE id = ?');
            stmt.run(report.patient_name, report.patient_id, JSON.stringify(report.report_data), report.id);
            return { success: true };
        } catch (err) {
            console.error('Error updating report:', err);
            throw err;
        }
    });

    ipcMain.handle('delete-report', (event, id) => {
        try {
            const stmt = db.prepare('DELETE FROM reports WHERE id = ?');
            return stmt.run(id);
        } catch (err) {
            console.error('Error deleting report:', err);
            throw err;
        }
    });

    // DATABASE EXPORT/IMPORT
    ipcMain.handle('export-db', async () => {
        const { filePath } = await dialog.showSaveDialog({
            title: 'Export Database',
            defaultPath: path.join(app.getPath('documents'), 'lab-database-backup.json'),
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });

        if (filePath) {
            try {
                const templates = db.prepare('SELECT * FROM test_templates').all();
                const reports = db.prepare('SELECT * FROM reports').all();
                const data = JSON.stringify({ templates, reports }, null, 2);
                fs.writeFileSync(filePath, data);
                return { success: true, message: 'Database exported successfully!' };
            } catch (err) {
                console.error('Export failed:', err);
                return { success: false, message: err.message };
            }
        }
        return { success: false, message: 'Export cancelled' };
    });

    ipcMain.handle('import-db', async () => {
        const { filePaths } = await dialog.showOpenDialog({
            title: 'Import Database',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile']
        });

        if (filePaths && filePaths[0]) {
            try {
                const rawData = fs.readFileSync(filePaths[0], 'utf8');
                const { templates, reports } = JSON.parse(rawData);

                // Start a transaction for safe merging
                const insertTemplate = db.prepare('INSERT OR IGNORE INTO test_templates (name, items, created_at) VALUES (?, ?, ?)');
                const insertReport = db.prepare('INSERT OR IGNORE INTO reports (patient_name, patient_id, report_data, created_at) VALUES (?, ?, ?, ?)');

                const transaction = db.transaction(() => {
                    if (templates) {
                        for (const t of templates) {
                            insertTemplate.run(t.name, t.items, t.created_at);
                        }
                    }
                    if (reports) {
                        for (const r of reports) {
                            insertReport.run(r.patient_name, r.patient_id, r.report_data, r.created_at);
                        }
                    }
                });

                transaction();
                return { success: true, message: 'Database imported and merged successfully!' };
            } catch (err) {
                console.error('Import failed:', err);
                return { success: false, message: err.message };
            }
        }
        return { success: false, message: 'Import cancelled' };
    });



    ipcMain.handle('get-next-patient-id', () => {
        try {
            const row = db.prepare('SELECT COUNT(*) as count FROM reports').get();
            const nextNum = (row.count || 0) + 1;
            const year = new Date().getFullYear();
            return `AL-${year}-${String(nextNum).padStart(4, '0')}`;
        } catch (err) {
            console.error('Error getting next patient ID:', err);
            return `AL-${new Date().getFullYear()}-0001`;
        }
    });

    ipcMain.handle('delete-all-reports', () => {
        try {
            db.prepare('DELETE FROM reports').run();
            // Also reset internal sqlite sequence for ID generation if needed, 
            // but for patient ID we use COUNT+1 usually.
            return { success: true, message: 'All patient records deleted successfully.' };
        } catch (err) {
            console.error('Delete all error:', err);
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('delete-all-test-templates', () => {
        try {
            db.prepare('DELETE FROM test_templates').run();
            return { success: true, message: 'All test templates deleted successfully.' };
        } catch (err) {
            console.error('Delete all templates error:', err);
            return { success: false, message: err.message };
        }
    });

    ipcMain.handle('print-window', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            try {
                // Returns a promise that resolves when the print job is finished or cancelled
                await win.webContents.print({ silent: false, printBackground: true, deviceName: '' });
                return { success: true };
            } catch (err) {
                console.error('Printing failed or cancelled:', err);
                return { success: false, error: err.message };
            }
        }
        return { success: false, error: 'Window not found' };
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
