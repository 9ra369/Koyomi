const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");

const EMPTY_STATE = { schemaVersion: 1, projects: [], sessions: [], activeTimer: null };

// プロジェクト直下の data/ フォルダでデータを管理する（Electron標準の userData ではない）
const DATA_DIR = path.join(__dirname, "data");

function dataPath() {
  return path.join(DATA_DIR, "data.json");
}
function bakPath() {
  return path.join(DATA_DIR, "data.json.bak");
}
function tmpPath() {
  return path.join(DATA_DIR, "data.json.tmp");
}

async function readStateFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!data || data.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
  return data;
}

// SPEC.md §5.6 / §8.3: 本体が壊れていたら直前世代へフォールバックする
async function loadState() {
  try {
    return await readStateFile(dataPath());
  } catch (err) {
    try {
      return await readStateFile(bakPath());
    } catch (bakErr) {
      return EMPTY_STATE;
    }
  }
}

// SPEC.md §8.3: tmp に書いてからアトミックにリネームする
async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const json = JSON.stringify(state, null, 2);
  await fs.writeFile(tmpPath(), json, "utf8");
  await fs.rename(dataPath(), bakPath()).catch(() => {}); // 初回は data.json が存在しない
  await fs.rename(tmpPath(), dataPath());
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    title: "Koyomi",
    icon: path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ADR-2: レンダラーから呼べる IPC は loadState / saveState の2本のみ
ipcMain.handle("koyomi:loadState", () => loadState());
ipcMain.handle("koyomi:saveState", (_event, state) => saveState(state));
