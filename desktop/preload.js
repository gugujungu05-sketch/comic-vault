'use strict';
/** 本地界面专用桥：只暴露最小 API，页面拿不到 Node 能力 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const VERSION = '3.4.0.5';

contextBridge.exposeInMainWorld('cvApp', {
  version: VERSION,
  platform: 'desktop',

  /* 数据：全部走主进程直连服务器 */
  api: (opts) => ipcRenderer.invoke('cv:api', opts),
  asset: (p) => ipcRenderer.sendSync('cv:asset', p),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  /* 原生文件能力 */
  pickFiles: () => ipcRenderer.invoke('cv:pick-files'),
  pickFolder: () => ipcRenderer.invoke('cv:pick-folder'),
  pickImport: () => ipcRenderer.invoke('cv:pick-import'),
  resolvePaths: (paths) => ipcRenderer.invoke('cv:resolve-paths', paths),
  /* 导入网格缩略图 */
  thumb: (p) => ipcRenderer.invoke('cv:thumb', p),
  /* 头像裁剪 */
  readImageData: (p) => ipcRenderer.invoke('cv:read-image-data', p),
  saveTempImage: (dataUrl, nameHint) => ipcRenderer.invoke('cv:save-temp-image', dataUrl, nameHint),
  /* PDF 导入：渲染进程用 pdf.js 逐页渲染成图片 */
  readFileBase64: (p) => ipcRenderer.invoke('cv:read-file-base64', p),
  pdfjsSource: () => ipcRenderer.invoke('cv:pdfjs-source'),
  copyText: (text) => ipcRenderer.invoke('cv:copy-text', text),

  /* 配置与更新（更新只在设置页触发） */
  getConfig: () => ipcRenderer.invoke('cv:get-config'),
  setMode: (mode) => ipcRenderer.invoke('cv:set-mode', mode),
  setServer: (url) => ipcRenderer.invoke('cv:set-server', url),
  setTheme: (theme) => ipcRenderer.invoke('cv:set-theme', theme),
  checkUpdate: () => ipcRenderer.invoke('cv:check-update'),
  installUpdate: (url) => ipcRenderer.invoke('cv:update-install', url),
  siteUrl: () => ipcRenderer.invoke('cv:site-url'),
  openExternal: (url) => ipcRenderer.invoke('cv:open-external', url),
  openDownload: () => ipcRenderer.invoke('cv:open-download'),

  /* 独立阅读窗口 */
  openReader: (comicId, chapterId) => ipcRenderer.invoke('cv:open-reader', comicId, chapterId),
  getReaderInit: () => ipcRenderer.invoke('cv:reader-init'),
  closeReader: () => ipcRenderer.invoke('cv:close-reader'),
  toggleFullscreen: () => ipcRenderer.invoke('cv:toggle-fullscreen'),

  /* 下载服务器上的文件（如 CBZ 导出）到用户选择的位置 */
  saveApiFile: (apiPath, defaultName) => ipcRenderer.invoke('cv:save-api-file', apiPath, defaultName),

  /* 原生菜单动作 */
  onMenu: (cb) => ipcRenderer.on('cv:menu', (_e, action) => cb(action)),
});
