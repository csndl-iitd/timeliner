const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fetch = require('node-fetch');

const CLIENT_ID = "Ov23li02k0fGu3YfPoL6";

const keytar = require('keytar');
const SERVICE_NAME = 'GitHub-Timelines';
const ACCOUNT_NAME = 'user-access-token';

async function getStoredToken() {
  return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
}

async function storeToken(token) {
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token);
}

async function clearToken() {
  await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();

  // Check for stored token after window loads
  mainWindow.webContents.on('did-finish-load', async () => {
    const savedToken = await getStoredToken();
    if (savedToken) {
      console.log('Found stored token, resuming session');
      mainWindow.webContents.send('auth-success', savedToken);
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Request device code and return it to renderer
ipcMain.handle('start-oauth', async () => {
  try {
    const resp = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: 'repo read:org' })
    });
    const data = await resp.json();
    if (!data.device_code) throw new Error('Failed to obtain device code from GitHub');
    // open the verification URL in user's browser
    if (data.verification_uri_complete) shell.openExternal(data.verification_uri_complete);
    else if (data.verification_uri) shell.openExternal(data.verification_uri);
    return data;
  } catch (e) { console.error('start-oauth error', e); throw e; }
});

// Poll for token using device_code
ipcMain.handle('poll-token', async (_event, deviceData) => {
  try {
    const intervalMs = (deviceData.interval || 5) * 1000;
    const expiresAt = Date.now() + ((deviceData.expires_in || 900) * 1000);
    while (Date.now() < expiresAt) {
      await new Promise(r => setTimeout(r, intervalMs));
      const p = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          device_code: deviceData.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      });
      const j = await p.json();
      if (j.access_token) return j.access_token;
      if (j.error && j.error !== 'authorization_pending') throw new Error(j.error_description || j.error);
    }
    throw new Error('Device flow timed out');
  } catch (e) { console.error('poll-token error', e); throw e; }
});

ipcMain.handle('submit-pat', async (_ev, pat) => { return pat; });
ipcMain.handle('open-external', (_ev, url) => shell.openExternal(url));

ipcMain.handle('save-token', async (_event, token) => {
  await storeToken(token);
  return true;
});

ipcMain.handle('logout', async () => {
  await clearToken();
  return true;
});