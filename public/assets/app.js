'use strict';

const state = {
  currentPath: '/',
  entries: [],
  searchGeneration: 0,
  searchTimer: null,
  history: ['/'],
  historyIndex: 0,
  sort: { key: 'name', direction: 'asc' },
  selected: new Map(),
  selectionAnchor: null,
  estimateTimer: null,
  estimateGeneration: 0,
  folderPickerPath: '/',
  windowsHandle: null,
  windowsAccessGeneration: 0,
  lastJob: null,
  lastArchivePreview: null,
  sourceHostname: 'linux',
  lastRestoreJob: null,
  restorePlan: null,
  restoreSource: 'windows',
  restoreUploadId: null,
  restoreLinuxSelectedPath: null,
  folderPickerPurpose: 'archive-destination',
  settings: { session_timeout: 1800, default_format: 'tar.gz', role: 'user', username: '' },
  contextPath: null,
  contextEntry: null,
  clipboard: null,
  renamePath: null,
  deletePath: null,
  deleteCritical: false,
  archiveContextPath: null,
  userEditing: null,
  userPasswordTarget: null,
  users: [],
  currentUsername: '',
  sessionTimer: null,
  lastServerActivity: Date.now(),
  transferLinuxPath: '/',
  transferLinuxEntries: [],
  transferLinuxSelected: new Map(),
  transferLinuxAnchor: null,
  transferWindowsRoot: null,
  transferWindowsStack: [],
  transferWindowsRenderedHandle: null,
  transferWindowsEntries: [],
  transferWindowsSelected: new Map(),
  transferWindowsAnchor: null,
  transferClipboard: null,
  transferInternalDrag: null,
  transferDropBusy: false,
  editor: { path:null, original:'', sha256:'', lineEnding:'lf', bom:false, critical:false, dirty:false },
  // Browser-memory only: do not write edited configuration contents into localStorage.
  lastSavedReview: null,
};

const csrf = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function toast(message, ms = 3200) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-Token', csrf);
  }
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (response.status === 401 && data && data.login_required) { window.location.href='login.php'; throw new Error('Login required'); }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  markServerActivity();
  return data;
}

function markServerActivity() {
  state.lastServerActivity = Date.now();
  scheduleSessionExpiry();
}

function scheduleSessionExpiry() {
  clearTimeout(state.sessionTimer);
  const seconds = Number(state.settings.session_timeout || 1800);
  const elapsed = Date.now() - state.lastServerActivity;
  const remaining = Math.max(1000, seconds * 1000 - elapsed);
  state.sessionTimer = setTimeout(() => {
    window.location.href = 'logout.php?reason=idle';
  }, remaining);
}

function applyTheme(theme) {
  const chosen = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = chosen;
  try { localStorage.setItem('lae-theme', chosen); } catch {}
  const btn = $('themeToggle');
  if (btn) {
    btn.textContent = chosen === 'dark' ? '☀ Light' : '☾ Dark';
    btn.setAttribute('aria-label', chosen === 'dark' ? 'Switch to Light mode' : 'Switch to Dark mode');
  }
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB','MB','GB','TB','PB'];
  let value = n;
  let i = -1;
  do { value /= 1024; i++; } while (value >= 1024 && i < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 1;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function formatModified(epoch) {
  if (!epoch) return '—';
  const d = new Date(epoch * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pathJoin(parent, name) {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}
function parentPath(path) {
  if (path === '/') return '/';
  const p = path.replace(/\/+$/, '').split('/');
  p.pop();
  return p.length <= 1 ? '/' : p.join('/');
}
function baseName(path) {
  if (path === '/') return '/';
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '/';
}
function isDescendant(path, parent) {
  if (parent === '/') return path !== '/';
  return path.startsWith(parent.replace(/\/+$/, '') + '/');
}

function selectionModalVisible(){return !$('selectionModal').classList.contains('hidden');}
function removeSelectedPath(path){
  let changed=false;
  for(const key of [...state.selected.keys()]){
    if(key===path||isDescendant(key,path)){state.selected.delete(key);changed=true;}
  }
  return changed;
}
function normalizeSelection(){
  const ordered=[...state.selected.keys()].sort((a,b)=>a.length-b.length||a.localeCompare(b));
  const kept=[];let changed=false;
  for(const key of ordered){
    if(kept.some(parent=>key===parent||isDescendant(key,parent))){state.selected.delete(key);changed=true;continue;}
    kept.push(key);
  }
  return changed;
}
function remapSelectedPath(oldPath,newPath){
  const changes=[];
  for(const [key,item] of state.selected.entries()){
    if(key===oldPath||isDescendant(key,oldPath)){
      const suffix=key.slice(oldPath.length);const next=newPath+suffix;
      changes.push([key,next,{...item,path:next,name:baseName(next)}]);
    }
  }
  for(const [oldKey,newKey,item] of changes){state.selected.delete(oldKey);state.selected.set(newKey,item);}
  if(changes.length)normalizeSelection();
  return changes.length>0;
}
function reconcileCurrentFolderSelection(){
  const present=new Set((state.entries||[]).map(e=>e.name));let changed=false;
  for(const key of [...state.selected.keys()]){
    if(parentPath(key)===state.currentPath&&!present.has(baseName(key))){state.selected.delete(key);changed=true;}
  }
  return changed;
}
function refreshSelectionState(){
  renderFiles();updateSelectionUI();maybeSuggestName();
  if(selectionModalVisible())renderSelectionModal(false);
}
async function refreshAfterLinuxMutation({containers=[],removed=[],renamed=[],tree=false}={}){
  let selectionChanged=false;
  for(const path of removed)selectionChanged=removeSelectedPath(path)||selectionChanged;
  for(const pair of renamed)selectionChanged=remapSelectedPath(pair.oldPath,pair.newPath)||selectionChanged;
  let mainTarget=state.currentPath;
  for(const path of removed){if(mainTarget===path||isDescendant(mainTarget,path)){mainTarget=parentPath(path);break;}}
  for(const pair of renamed){if(mainTarget===pair.oldPath||isDescendant(mainTarget,pair.oldPath)){mainTarget=pair.newPath+mainTarget.slice(pair.oldPath.length);break;}}
  const mainAffected=mainTarget!==state.currentPath||containers.includes(state.currentPath)||removed.some(p=>parentPath(p)===state.currentPath)||renamed.some(p=>parentPath(p.oldPath)===state.currentPath||parentPath(p.newPath)===state.currentPath);
  if(mainAffected){
    const sameFolder=mainTarget===state.currentPath;
    await navigate(mainTarget,false,!sameFolder);
    if(selectionChanged){updateSelectionUI();maybeSuggestName();if(selectionModalVisible())renderSelectionModal(false);}
  }else if(selectionChanged)refreshSelectionState();
  if(!$('transferModal').classList.contains('hidden')){
    const transferAffected=containers.includes(state.transferLinuxPath)||removed.some(p=>parentPath(p)===state.transferLinuxPath||p===state.transferLinuxPath||isDescendant(state.transferLinuxPath,p))||renamed.some(p=>parentPath(p.oldPath)===state.transferLinuxPath||parentPath(p.newPath)===state.transferLinuxPath||p.oldPath===state.transferLinuxPath);
    if(transferAffected)await refreshTransferLinux();
  }
  if(tree)await buildTree();
}

function renderBreadcrumbs() {
  const el = $('breadcrumbs');
  el.innerHTML = '';
  const root = document.createElement('button');
  root.className = 'crumb crumb-root'; root.textContent = '▰  /'; root.dataset.tip='Open filesystem root /'; root.onclick = () => navigate('/');
  el.appendChild(root);
  const parts = state.currentPath.split('/').filter(Boolean);
  let running = '';
  for (const part of parts) {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '›'; el.appendChild(sep);
    running += '/' + part;
    const btn = document.createElement('button'); btn.className = 'crumb'; btn.textContent = part;
    const target = running; btn.dataset.tip=`Open ${target}`; btn.onclick = () => navigate(target); el.appendChild(btn);
  }
}

function isArchiveName(name) {
  return /\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.zst|tzst|zip)$/i.test(String(name));
}

function isEditableTextCandidate(entry) { return !!entry && entry.is_regular === true && !isArchiveName(entry.name); }


function fileIcon(entry) {
  if (entry.is_dir) return '<span class="fileicon folder">📁</span>';
  if (isArchiveName(entry.name)) return `<span class="fileicon file archive">${entry.name.toLowerCase().endsWith('.zip')?'ZIP':'TAR'}</span>`;
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  if (ext === 'php') return '<span class="fileicon file php">PHP</span>';
  if (ext === 'js') return '<span class="fileicon file js">JS</span>';
  if (ext === 'css') return '<span class="fileicon file css">{ }</span>';
  if (['png','jpg','jpeg','gif','webp','svg','ico'].includes(ext)) return '<span class="fileicon file image">IMG</span>';
  return '<span class="fileicon file">FILE</span>';
}

function typeLabel(entry) {
  if (entry.is_symlink) return entry.is_dir ? 'Folder shortcut' : 'Symbolic link';
  if (entry.is_dir) return 'Folder';
  if (isArchiveName(entry.name)) return entry.name.toLowerCase().endsWith('.zip') ? 'ZIP Archive' : 'Tar Archive';
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  const map = {php:'PHP File',md:'Markdown File',conf:'Configuration File',ini:'Configuration File',css:'CSS File',js:'JavaScript File',json:'JSON File',png:'PNG Image',jpg:'JPEG Image',jpeg:'JPEG Image',svg:'SVG Image',ico:'Icon File',txt:'Text File',sh:'Shell Script',service:'Service File'};
  return map[ext] || 'File';
}

function sortedEntries() {
  const q = $('searchInput').value.trim().toLocaleLowerCase();
  const filtered = q ? state.entries.filter(e => e.name.toLocaleLowerCase().includes(q)) : [...state.entries];
  const {key, direction} = state.sort;
  const dir = direction === 'asc' ? 1 : -1;
  return filtered.sort((a,b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let av, bv;
    if (key === 'name') { av=a.name.toLocaleLowerCase(); bv=b.name.toLocaleLowerCase(); }
    else if (key === 'type') { av=typeLabel(a); bv=typeLabel(b); }
    else if (key === 'size') { av=a.size ?? -1; bv=b.size ?? -1; }
    else { av=a.modified ?? 0; bv=b.modified ?? 0; }
    if (typeof av === 'string') return av.localeCompare(bv, undefined, {numeric:true,sensitivity:'base'}) * dir;
    return (av-bv)*dir;
  });
}

function applyExplorerRange(items,index){
  const anchor=state.selectionAnchor;
  if(anchor===null||anchor<0||anchor>=items.length)return false;
  for(let i=Math.min(anchor,index);i<=Math.max(anchor,index);i++){
    const item=items[i];if(!item.selectable)continue;
    const p=pathJoin(state.currentPath,item.name);
    state.selected.set(p,{path:p,name:item.name,is_dir:item.is_dir,size:item.size});
  }
  return true;
}
function selectExplorerRow(items,index,entry,ev){
  if(!entry.selectable)return;
  const path=pathJoin(state.currentPath,entry.name);
  if(ev.shiftKey&&applyExplorerRange(items,index)){
    // keep anchor from the original click
  }else if(ev.ctrlKey||ev.metaKey){
    if(state.selected.has(path))state.selected.delete(path);else state.selected.set(path,{path,name:entry.name,is_dir:entry.is_dir,size:entry.size});
    state.selectionAnchor=index;
  }else{
    state.selected.clear();state.selected.set(path,{path,name:entry.name,is_dir:entry.is_dir,size:entry.size});state.selectionAnchor=index;
  }
  renderFiles();updateSelectionUI();maybeSuggestName();
}
function renderFiles() {
  const tbody = $('fileRows');
  const items = sortedEntries();
  tbody.innerHTML = '';
  items.forEach((entry,index)=>{
    const path = pathJoin(state.currentPath, entry.name);
    const selected = state.selected.has(path);
    const tr = document.createElement('tr');
    tr.dataset.path = path;
    if (selected) tr.classList.add('selected');
    if (!entry.selectable && !entry.is_dir) tr.classList.add('mutedrow');
    if (entry.protected) tr.dataset.tip='Virtual system location. Browsing is allowed; archive selection and file changes are disabled.';
    else if(entry.managed) tr.dataset.tip='Linux Archive Explorer managed workspace. Administrators may browse and manage contents with normal safety checks.';
    const folderTip=(entry.is_dir&&entry.browsable!==false)?`Double-click to open folder: ${path}`:path;
    tr.innerHTML = `
      <td class="checkcol"><input type="checkbox" ${selected?'checked':''} ${entry.selectable?'':'disabled'} aria-label="Select ${escapeHtml(entry.name)} for archive" data-tip="${entry.selectable?'Select for Create Archive or Copy Selected / Cut Selected. Paste is in the right-click menu.':'This system location cannot be archived'}"></td>
      <td><div class="filenamecell">${fileIcon(entry)}<span class="filename ${entry.is_dir?'foldername':''}" title="${escapeHtml(folderTip)}">${escapeHtml(entry.name)}</span></div></td>
      <td>${escapeHtml(typeLabel(entry))}</td>
      <td class="numcol" ${entry.is_dir?'data-tip="Folder size is calculated on request. Right-click the folder and choose Properties to see its total size."':''}>${entry.is_dir ? '—' : formatBytes(entry.size)}</td>
      <td>${formatModified(entry.modified)}</td>`;
    const cb = tr.querySelector('input[type=checkbox]');
    cb.addEventListener('click', (ev) => { ev.stopPropagation(); state.selectionAnchor=index; toggleSelection(path, entry, cb.checked); });
    tr.addEventListener('click',ev=>{if(ev.target.closest('input,button,a'))return;selectExplorerRow(items,index,entry,ev);});
    if (entry.is_dir && entry.browsable!==false) {
      tr.addEventListener('dblclick', (ev) => { if (!ev.target.matches('input')) navigate(path); });
      if(isAdmin()){
        tr.addEventListener('dragover',ev=>{if(ev.dataTransfer&&ev.dataTransfer.types.includes('Files')){ev.preventDefault();ev.stopPropagation();tr.classList.add('drop-target');}});
        tr.addEventListener('dragleave',()=>tr.classList.remove('drop-target'));
        tr.addEventListener('drop',ev=>{tr.classList.remove('drop-target');handleExplorerDrop(ev,path).catch(err=>toast(err.message,7000));});
      }
    } else if (isArchiveName(entry.name)) {
      tr.addEventListener('dblclick', (ev) => { if (!ev.target.matches('input')) openArchivePath(path); });
    } else if (isEditableTextCandidate(entry)) {
      tr.addEventListener('dblclick', (ev) => {
        if (ev.target.matches('input')) return;
        ev.preventDefault();
        if (!isAdmin()) { toast('Administrator access required. Editing files is available only to Administrator accounts.',6500); return; }
        removeSelectedPath(path);
        state.selectionAnchor=null;
        refreshSelectionState();
        openTextEditor(path).catch(err=>toast(err.message,6500));
      });
    }
    tr.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); showContextMenu(ev.clientX, ev.clientY, path, entry); });
    tbody.appendChild(tr);
  });
  $('loadingState').classList.add('hidden');
  $('emptyState').classList.toggle('hidden', items.length !== 0);
  updateSelectAll(items);
}

function updateSelectAll(items = sortedEntries()) {
  const eligible = items.filter(e => e.selectable);
  const selected = eligible.filter(e => state.selected.has(pathJoin(state.currentPath,e.name))).length;
  const cb = $('selectAll');
  cb.checked = eligible.length > 0 && selected === eligible.length;
  cb.indeterminate = selected > 0 && selected < eligible.length;
  cb.disabled = eligible.length === 0;
}

function showRecursiveResults(active) {
  $('recursiveResults').classList.toggle('hidden', !active);
  document.querySelector('.filetable-wrap').classList.toggle('hidden', active);
}
function cancelRecursiveSearch() {
  state.searchGeneration++;
  clearTimeout(state.searchTimer);
  showRecursiveResults(false);
}
function queueSearch() {
  const query = $('searchInput').value.trim();
  const recursive = $('searchSubfolders').checked;
  const generation = ++state.searchGeneration;
  clearTimeout(state.searchTimer);
  if (!recursive || query.length < 2) {
    showRecursiveResults(false);
    renderFiles();
    return;
  }
  showRecursiveResults(true);
  $('recursiveStatus').textContent = `Searching subfolders of ${state.currentPath}…`;
  $('recursiveRows').innerHTML = '';
  const folder = state.currentPath;
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await api(`api/search.php?path=${encodeURIComponent(folder)}&query=${encodeURIComponent(query)}`);
      if (generation !== state.searchGeneration || folder !== state.currentPath) return;
      const tbody = $('recursiveRows'); tbody.innerHTML = '';
      for (const item of data.entries) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</td><td title="${escapeHtml(item.parent)}">${escapeHtml(item.parent)}</td><td>${item.is_dir?'Folder':'File'}</td><td></td>`;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'recursive-open';
        button.textContent = 'Open location';
        button.dataset.tip = `Open ${item.parent} and highlight ${item.name}`;
        button.addEventListener('click', () => openSearchLocation(item.path));
        tr.lastElementChild.appendChild(button); tbody.appendChild(tr);
      }
      const total = data.entries.length;
      $('recursiveStatus').textContent = `${total} match${total===1?'':'es'} under ${folder}${data.partial?' (limit reached; narrow the search or open a subfolder)':''}. Results are filenames only; mounted filesystems are not traversed.`;
    } catch (error) {
      if (generation !== state.searchGeneration) return;
      $('recursiveStatus').textContent = `Search unavailable: ${error.message}`;
    }
  }, 350);
}
async function openSearchLocation(path) {
  const folder = parentPath(path);
  const ok = await navigate(folder, true, true);
  if (!ok) return;
  const row = [...document.querySelectorAll('#fileRows tr[data-path]')].find(tr=>tr.dataset.path===path);
  if (row) {
    row.scrollIntoView({block:'center'});
    row.classList.add('search-found-flash');
    setTimeout(()=>row.classList.remove('search-found-flash'),2500);
  }
}

async function navigate(path, addHistory = true, clearSearch = true) {
  const previousPath = state.currentPath;
  $('loadingState').classList.remove('hidden');
  $('emptyState').classList.add('hidden');
  try {
    const data = await api(`api/list.php?path=${encodeURIComponent(path)}`);
    state.currentPath = data.path;
    state.entries = data.entries;
    const folderChanged = state.currentPath !== previousPath;
    let selectionChanged = false;
    if (folderChanged) {
      selectionChanged = state.selected.size > 0;
      state.selected.clear();
      state.selectionAnchor = null;
    } else {
      selectionChanged = reconcileCurrentFolderSelection();
    }
    if (addHistory && state.history[state.historyIndex] !== state.currentPath) {
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(state.currentPath); state.historyIndex++;
    }
    if(clearSearch)$('searchInput').value = '';
    cancelRecursiveSearch();
    renderBreadcrumbs(); renderFiles(); updateNavButtons(); markTreeActive();
    // A same-folder refresh retains an active recursive search and its search text.
    if (!clearSearch && $('searchSubfolders').checked && $('searchInput').value.trim().length >= 2) queueSearch();
    // New folder: show its first item, rather than the previous folder's scroll position.
    // Refreshing the current folder (e.g. after an edit/transfer) keeps the user's place.
    if (state.currentPath !== previousPath) {
      const list = document.querySelector('.filetable-wrap');
      if (list) { list.scrollTop = 0; list.scrollLeft = 0; }
    }
    if(selectionChanged){updateSelectionUI();maybeSuggestName();if(selectionModalVisible())renderSelectionModal(false);}
    return true;
  } catch (err) {
    $('loadingState').classList.add('hidden'); toast(err.message, 5000);
    return false;
  }
}

function updateNavButtons() {
  $('backBtn').disabled = state.historyIndex <= 0;
  $('forwardBtn').disabled = state.historyIndex >= state.history.length - 1;
  $('upBtn').disabled = state.currentPath === '/';
}

function toggleSelection(path, entry, add) {
  if (add) {
    // An explicit child selection replaces any selected ancestor. This matters
    // after double-click navigation, because the folder used to enter the
    // current directory may still be part of the cross-folder selection.
    // Silently refusing the child makes its checkbox appear broken.
    for (const existing of [...state.selected.keys()]) {
      if (existing === path) { renderFiles(); return; }
      if (isDescendant(path, existing)) state.selected.delete(existing);
    }
    // Selecting a parent makes separate descendants redundant.
    if (entry.is_dir) {
      for (const existing of [...state.selected.keys()]) if (isDescendant(existing, path)) state.selected.delete(existing);
    }
    state.selected.set(path, { path, name: entry.name, is_dir: entry.is_dir, size: entry.size });
  } else {
    state.selected.delete(path);
  }
  renderFiles(); updateSelectionUI(); maybeSuggestName();
}

function updateSelectionUI() {
  const count = state.selected.size;
  const generation=++state.estimateGeneration;
  $('selectionCount').textContent = `Selected: ${count} item${count===1?'':'s'}`;
  if($('createBtn'))$('createBtn').disabled=count===0;
  $('selectionSize').textContent = count ? 'Calculating…' : '0 B';
  $('footerSelection').textContent = `${count} item${count===1?'':'s'} selected • ${count?'Calculating…':'0 B'}`;
  clearTimeout(state.estimateTimer);
  if (!count) return;
  const paths=[...state.selected.keys()];
  state.estimateTimer = setTimeout(async () => {
    try {
      const data = await api('api/estimate.php', {method:'POST', body:JSON.stringify({paths})});
      if(generation!==state.estimateGeneration)return;
      const text = data.complete ? formatBytes(data.bytes) : `≥ ${formatBytes(data.bytes)}`;
      $('selectionSize').textContent = `${text}${data.complete?'':' (partial estimate)'}`;
      $('footerSelection').textContent = `${count} item${count===1?'':'s'} selected • ${text}`;
    } catch { if(generation===state.estimateGeneration)$('selectionSize').textContent = 'Size unavailable'; }
  }, 350);
}

function maybeSuggestName() {
  const field = $('archiveName');
  if (field.dataset.edited === '1') return;
  const date = new Date();
  const pad=n=>String(n).padStart(2,'0');
  const ds=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const host=String(state.sourceHostname||'linux').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'linux';
  if (state.selected.size === 1) field.value = `${host}-${baseName([...state.selected.keys()][0]).replace(/[^\p{L}\p{N}._ -]+/gu,'-')}-backup-${ds}`;
  else field.value = state.selected.size > 1 ? `${host}-archive-backup-${ds}` : `${host}-archive-${ds}`;
}

function renderSelectionModal(open=true) {
  const box = $('selectionList'); box.innerHTML='';
  if (!state.selected.size) box.innerHTML='<div class="empty-state" style="position:static;height:120px">No files or folders selected.</div>';
  for (const item of state.selected.values()) {
    const row=document.createElement('div'); row.className='selecteditem';
    row.innerHTML=`<span>${item.is_dir?'📁':'▧'}</span><span class="selectedpath" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span><button class="removeitem" title="Remove">×</button>`;
    row.querySelector('button').onclick=()=>{state.selected.delete(item.path);renderSelectionModal(false);renderFiles();updateSelectionUI();maybeSuggestName();};
    box.appendChild(row);
  }
  if(open)showModal('selectionModal');
}

let tooltipTimer = null;
function dismissTooltip() {
  clearTimeout(tooltipTimer);
  const tip = $('tooltip');
  if (tip) tip.classList.add('hidden');
}
function showModal(id){
  dismissTooltip();
  const modal=$(id);
  const visible=[...document.querySelectorAll('.modalbackdrop:not(.hidden)')].filter(el=>el!==modal);
  const highest=Math.max(100,...visible.map(el=>parseInt(el.style.zIndex||getComputedStyle(el).zIndex,10)||100));
  modal.style.zIndex=String(highest+20);
  modal.classList.remove('hidden');
}
function hideModal(id){
  dismissTooltip();
  const modal=$(id);
  modal.classList.add('hidden');
  modal.style.zIndex='';
  if(id==='transferModal'){
    state.transferClipboard=null;
    state.transferInternalDrag=null;
    clearTransferDropMarkers();
  }
}

document.querySelectorAll('[data-close]').forEach(btn=>btn.addEventListener('click',()=>hideModal(btn.dataset.close)));
document.querySelectorAll('.modalbackdrop').forEach(back=>back.addEventListener('mousedown',e=>{if(e.target!==back)return;if(back.id==='progressModal')return;if(back.id==='editorModal'){closeTextEditor();return;}if(back.id==='conflictModal'){resolveConflictDialog('cancel');return;}hideModal(back.id);}));

function expandedTreePaths(){
  const paths=[];
  document.querySelectorAll('#tree .tree-node').forEach(node=>{const children=node.querySelector(':scope > .tree-children');if(children&&!children.classList.contains('hidden'))paths.push(node.dataset.path);});
  return paths;
}
async function buildTree() {
  const prior=new Set(expandedTreePaths());prior.add('/');
  const tree=$('tree'); tree.innerHTML='';
  const root=createTreeNode('/', '/', 0, true); tree.appendChild(root);
  await expandTreeNode(root, '/');
  const wanted=[...prior].filter(p=>p!=='/').sort((a,b)=>a.split('/').length-b.split('/').length);
  for(const path of wanted){const node=[...document.querySelectorAll('#tree .tree-node')].find(n=>n.dataset.path===path);if(!node)continue;await expandTreeNode(node,path);const children=node.querySelector(':scope > .tree-children');if(children)children.classList.remove('hidden');const toggle=node.querySelector(':scope > .tree-row > .tree-toggle');if(toggle&&!toggle.classList.contains('blank'))toggle.textContent='▼';}
  markTreeActive();
}
function createTreeNode(path, label, depth, expanded=false, protectedFolder=false){
  const node=document.createElement('div'); node.className='tree-node'; node.dataset.path=path; node.dataset.loaded='0';
  if(protectedFolder)node.dataset.protected='1';
  const row=document.createElement('div'); row.className='tree-row';
  const tip=protectedFolder?'Protected system/application folder. This location cannot be browsed, selected or archived.':`Open ${path}`;
  // Use the application's tooltip only. Native title attributes cause a second, white browser tooltip.
  const toggle=document.createElement('button'); toggle.className='tree-toggle'; toggle.textContent=expanded?'▼':'▶'; toggle.dataset.tip=tip;
  const folder=document.createElement('span'); folder.className='tree-folder'; folder.textContent='📁';
  const text=document.createElement('span'); text.className='tree-label'; text.textContent=label; text.dataset.tip=tip;
  row.dataset.tip=tip;
  if(protectedFolder){
    row.classList.add('protected');
    row.setAttribute('aria-disabled','true');
    toggle.disabled=true;
    toggle.classList.add('blank');
    text.setAttribute('aria-disabled','true');
  }
  row.append(toggle,folder,text); node.appendChild(row);
  const children=document.createElement('div'); children.className='tree-children'; if(!expanded)children.classList.add('hidden'); node.appendChild(children);
  if(!protectedFolder){
    toggle.onclick=async(e)=>{e.stopPropagation(); if(children.classList.contains('hidden')){await expandTreeNode(node,path);children.classList.remove('hidden');toggle.textContent='▼';}else{children.classList.add('hidden');toggle.textContent='▶';}};
    text.onclick=()=>navigate(path);
  }
  return node;
}
async function expandTreeNode(node,path){
  if(node.dataset.loaded==='1'||node.dataset.protected==='1')return;
  try{
    const data=await api(`api/list.php?path=${encodeURIComponent(path)}&dirs=1`);
    const children=node.querySelector(':scope > .tree-children'); children.innerHTML='';
    for(const entry of data.entries.filter(e=>e.is_dir)) children.appendChild(createTreeNode(pathJoin(path,entry.name),entry.name,0,false,Boolean(entry.browsable===false)));
    node.dataset.loaded='1';
    const toggle=node.querySelector(':scope > .tree-row > .tree-toggle'); if(!data.entries.some(e=>e.is_dir)){toggle.classList.add('blank');toggle.textContent='▶';}
  }catch(err){toast(`Unable to expand ${path}: ${err.message}`);}
}
function markTreeActive(){ document.querySelectorAll('.tree-row.active').forEach(e=>e.classList.remove('active')); const node=[...document.querySelectorAll('.tree-node')].find(n=>n.dataset.path===state.currentPath); if(node)node.querySelector(':scope > .tree-row').classList.add('active'); }

function updateDestinationUI(){
  const dest=document.querySelector('input[name=destination]:checked').value;
  const hasWin=dest==='windows'||dest==='both', hasLinux=dest==='linux'||dest==='both';
  $('windowsRow').style.display=hasWin?'grid':'none';
  $('linuxRow').style.display=hasLinux?'grid':'none';
}

function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open('linux-archive-explorer',1);r.onupgradeneeded=()=>r.result.createObjectStore('handles');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function storeHandle(handle){try{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction('handles','readwrite');tx.objectStore('handles').put(handle,'windows-dir');tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});db.close();}catch(e){console.warn(e);}}
async function loadStoredHandle(){try{const db=await openDb();const h=await new Promise((res,rej)=>{const tx=db.transaction('handles','readonly');const r=tx.objectStore('handles').get('windows-dir');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});db.close();return h;}catch{return null;}}
async function clearStoredWindowsHandle(){try{const db=await openDb();await new Promise((resolve,reject)=>{const tx=db.transaction('handles','readwrite');tx.objectStore('handles').delete('windows-dir');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();}catch(err){console.warn('Unable to clear expired Windows folder permission',err);}}
function transferWindowsMessage(message,kind='notice'){
  const list=$('transferWindowsList');list.innerHTML='';const box=document.createElement('div');box.className='transfer-empty'+(kind==='error'?' error':'');box.textContent=message;list.appendChild(box);
  $('transferWindowsPath').textContent='No authorized folder';state.transferWindowsEntries=[];state.transferWindowsSelected.clear();state.transferWindowsAnchor=null;updateTransferSelectionUI();
  $('transferStatus').textContent='For Windows → Linux, use Ctrl+V or drag files onto Linux. For Linux → Windows, select Linux items and click To Windows to download.';
}
async function forgetTransferWindows(message){
  state.windowsAccessGeneration++;
  state.windowsHandle=null;state.transferWindowsRoot=null;state.transferWindowsStack=[];
  state.transferWindowsRenderedHandle=null;
  await clearStoredWindowsHandle();transferWindowsMessage(message);
}
function windowsAccessMessage(err){
  const name=err?.name||'';
  if(name==='SecurityError'||name==='NotAllowedError'||name==='NotReadableError')return 'Chrome cannot open this Windows folder. It may contain protected/system files or its permission has expired. Click Choose Folder and pick an ordinary folder. You can still paste or drag files into Linux, or download selected Linux items.';
  return 'This Windows folder cannot be opened. Choose another folder, or use Ctrl+V / drag-and-drop and browser downloads.';
}
function directWindowsSupported(){return window.isSecureContext && 'showDirectoryPicker' in window;}
async function chooseWindowsFolder(){
  if(!directWindowsSupported()){
    transferWindowsMessage('Full Windows folder browsing and direct Windows file management require HTTPS. Reopen Linux Archive Explorer with the HTTPS address provided by setup. On a clean installation, setup can provision an isolated local HTTPS endpoint without changing Tailscale. HTTP can still use Windows → Linux drag/drop/paste and Linux → Windows browser downloads.');
    return null;
  }
  try{
    // Only call the picker in response to the Choose Folder button; browsers require a real user gesture.
    const handle=await window.showDirectoryPicker({id:'linux-archive-explorer-transfer',mode:'readwrite'});
    state.windowsAccessGeneration++;
    state.windowsHandle=handle;
    await storeHandle(handle);
    return handle;
  }catch(err){
    if(err.name!=='AbortError'){
      const msg=windowsAccessMessage(err);
      await forgetTransferWindows(msg);toast(msg,8500);
    }
    return null;
  }
}
async function ensureWindowsPermission(){
  if(!directWindowsSupported())return false;
  if(!state.windowsHandle){const epoch=state.windowsAccessGeneration;const restored=await loadStoredHandle();if(epoch!==state.windowsAccessGeneration)return false;if(!state.windowsHandle)state.windowsHandle=restored;}
  if(!state.windowsHandle)return false;
  try{return (await state.windowsHandle.queryPermission({mode:'readwrite'}))==='granted';}catch{return false;}
}

async function openLinuxPicker(path,purpose='archive-destination'){ state.folderPickerPurpose=purpose; state.folderPickerPath=path||'/'; showModal('folderModal'); await renderLinuxPicker(); }
async function renderLinuxPicker(){
  $('folderPickerPath').textContent=state.folderPickerPath; const list=$('folderPickerList'); list.innerHTML='<div style="padding:18px;color:#718096">Loading…</div>';
  try{
    const data=await api(`api/list.php?path=${encodeURIComponent(state.folderPickerPath)}&dirs=1`); list.innerHTML='';
    for(const e of data.entries.filter(x=>x.is_dir)){
      const row=document.createElement('div');row.className='folderitem'+(e.selectable?'':' disabled');row.innerHTML=`<span class="folderglyph">📁</span><span>${escapeHtml(e.name)}</span>`;
      if(e.browsable!==false&&!e.protected)row.ondblclick=()=>{state.folderPickerPath=pathJoin(state.folderPickerPath,e.name);renderLinuxPicker();};
      list.appendChild(row);
    }
    if(!list.children.length)list.innerHTML='<div style="padding:18px;color:#718096">No subfolders.</div>';
  }catch(err){list.innerHTML=`<div style="padding:18px;color:#a33">${escapeHtml(err.message)}</div>`;}
}

function canonicalArchiveFilename() {
  const fmt=$('archiveFormat').value;
  const ext={"tar.gz":".tar.gz","tar.zst":".tar.zst","tar.xz":".tar.xz","tar":".tar","zip":".zip"}[fmt];
  let name=$('archiveName').value.trim();
  const suffixes=['.tar.gz','.tgz','.tar.zst','.tzst','.tar.xz','.txz','.tar','.zip'];
  const low=name.toLowerCase();
  for(const suffix of suffixes){if(low.endsWith(suffix)){name=name.slice(0,-suffix.length).trimEnd();break;}}
  return name+ext;
}
async function createArchive(){
  if(!state.selected.size){toast('Select at least one file or folder first.');return;}
  const name=$('archiveName').value.trim(); if(!name){toast('Enter an archive name.');return;}
  const dest=document.querySelector('input[name=destination]:checked').value;
  const payload={paths:[...state.selected.keys()],archive_name:name,format:$('archiveFormat').value,windows_requested:dest==='windows'||dest==='both',linux_destination:(dest==='linux'||dest==='both')?$('linuxPath').value:null};
  showModal('progressModal'); $('progressTitle').textContent='Preparing archive…';$('progressMessage').textContent='Validating selected files and folders.';$('stageFill').style.width='5%';$('stageCaption').textContent='Preparing';
  try{
    const created=await api('api/create.php',{method:'POST',body:JSON.stringify(payload)});
    await pollJob(created.job_id);
  }catch(err){hideModal('progressModal');toast(err.message,6000);}
}
async function watchJob(jobId,onUpdate){
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(job)=>{if(done)return;done=true;try{source&&source.close();}catch{}resolve(job);};
    const fail=(err)=>{if(done)return;done=true;try{source&&source.close();}catch{}reject(err);};
    const handle=(job)=>{if(onUpdate)onUpdate(job);if(['completed','warning','failed'].includes(job.status))finish(job);};
    let source=null;
    if('EventSource' in window){
      source=new EventSource(`api/events.php?id=${encodeURIComponent(jobId)}`);
      source.addEventListener('status',ev=>{try{const data=JSON.parse(ev.data);if(data.ok&&data.job){markServerActivity();handle(data.job);}}catch(e){}});
      source.onerror=()=>{try{source.close();}catch{};source=null;fallback();};
    } else fallback();
    async function fallback(){
      if(done)return;
      try{const data=await api(`api/status.php?id=${encodeURIComponent(jobId)}`);handle(data.job);}catch(err){fail(err);return;}
      if(!done)setTimeout(fallback,3000);
    }
  });
}

function applyProgress(job,title='Working'){
  const map={queued:[5,'Preparing'],scanning:[15,'Scanning selected items'],archiving:[48,'Creating archive'],copying:[82,'Saving Linux copy'],snapshotting:[20,'Creating safety backup'],restoring:[58,'Restoring files'],verifying:[82,'Verifying'],['rolling-back']:[70,'Rolling back'],completed:[100,'Complete'],warning:[100,'Complete with warning'],failed:[100,'Failed']};
  const [pct,caption]=map[job.status]||[10,title];
  $('stageFill').style.width=`${pct}%`;$('stageCaption').textContent=caption;$('progressTitle').textContent=caption;$('progressMessage').textContent=job.message||'Working…';
}

async function pollJob(jobId){
  try{
    const job=await watchJob(jobId,j=>applyProgress(j,'Creating archive'));
    hideModal('progressModal');state.lastJob=job;state.lastArchivePreview=null;
    if(job.status==='failed'){showResult(job,false,'Not downloaded');return;}
    // The Windows-only staged file disappears after full streaming. Cache the
    // verified contents BEFORE download so Open Archive never becomes a dead button.
    try{state.lastArchivePreview=await api(`api/archive.php?id=${encodeURIComponent(job.id)}`);state.lastArchivePreview.jobId=job.id;}
    catch(err){console.warn('Archive contents preview unavailable:',err.message);}
    const winStatus=job.windows_requested?'Ready — click Download to Windows':'Not requested';
    showResult(job,true,winStatus);
    delete $('archiveName').dataset.edited;
    state.selected.clear();
    renderFiles(); updateSelectionUI(); maybeSuggestName();
    if(job.linux_path)await refreshAfterLinuxMutation({containers:[parentPath(job.linux_path)]});
  }catch(err){hideModal('progressModal');toast(err.message,6000);}
}

function showResult(job,success,winStatus){
  $('resultHeading').textContent=success?(job.status==='warning'?'Archive Created with Warning':'Archive Created'):'Archive Failed';
  $('resultBanner').className='resultbanner '+(success?(job.status==='warning'?'warning':'success'):'error');
  $('resultBanner').querySelector('.bigcheck').textContent=success?(job.status==='warning'?'!':'✓'):'×';
  $('resultName').textContent=job.filename||job.archive_name||'Archive';$('resultSubtext').textContent=success?'Archive creation and integrity check finished.':(job.message||'Archive creation failed.');
  $('resultSize').textContent=job.size_bytes!=null?formatBytes(job.size_bytes):'—';$('resultSha').textContent=job.sha256||'—';$('resultLinux').textContent=job.linux_path||'Not requested';$('resultWindows').textContent=winStatus;
  const warn=$('resultWarning');if(job.warning){warn.textContent=job.warning;warn.classList.remove('hidden');}else warn.classList.add('hidden');
  $('downloadBtn').disabled=false;$('openArchiveBtn').disabled=false;$('downloadBtn').style.display=success&&job.windows_requested?'inline-block':'none';$('openArchiveBtn').style.display=success?'inline-block':'none';showModal('resultModal');
}

async function openArchiveContents(){
  if(!state.lastJob)return;
  try{const data=(state.lastArchivePreview?.jobId===state.lastJob.id?state.lastArchivePreview:await api(`api/archive.php?id=${encodeURIComponent(state.lastJob.id)}`));state.archiveContextPath=state.lastJob.linux_path||null;$('archiveContentTitle').textContent=state.lastJob.filename;$('archiveEntries').innerHTML=data.entries.map(x=>`<div class="archiveentry">${escapeHtml(x)}</div>`).join('');$('archiveEntryCount').textContent=`${data.entries.length} entries${data.truncated?' (first entries shown)':''}`;$('archiveVerifyStatus').textContent=`✓ Archive verified on Linux before download — SHA-256 ${state.lastJob.sha256||'available in result'}. A Windows-saved copy must be independently inspected after download.`;$('archiveVerifyStatus').className='archive-verify-status verified';for(const id of ['archiveVerifyBtn','archiveRestoreBtn','archiveDeleteBtn']){if($(id))$(id).disabled=!state.archiveContextPath;}showModal('archiveModal');}catch(err){toast(err.message,5000);}
}

const archiveSuffix=/\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.zst|tzst|zip)$/i;

async function discardRestoreUpload(){
  const id=state.restoreUploadId;
  if(!id)return;
  state.restoreUploadId=null;
  try{await api('api/upload.php?action=discard',{method:'POST',body:JSON.stringify({upload_id:id})});}
  catch(e){console.warn('Restore upload cleanup deferred to scheduled cleanup:',e.message);}
}
function clearRestoreInspection(){
  state.restorePlan=null;
  $('restorePreview').classList.add('hidden');$('restorePreview').innerHTML='';
  $('continueRestoreBtn').classList.add('hidden');$('inspectRestoreBtn').disabled=true;
  $('inspectRestoreBtn').textContent='Inspect Archive';
  $('inspectRestoreBtn').dataset.tip='Verify the selected archive and show what a restore would change';
  $('restoreStatus').textContent='';
}
function resetRestore(){
  clearRestoreInspection();
  state.restoreUploadId=null;state.restoreLinuxSelectedPath=null;
  // File inputs retain their FileList across modal closes: clear it explicitly.
  $('restoreFile').value='';$('restoreFileName').textContent='No file selected';
  $('uploadProgress').classList.add('hidden');$('uploadFill').style.width='0%';$('uploadText').textContent='';
  $('restoreArchiveList').innerHTML='';
}


async function openRestore(){resetRestore();showModal('restoreModal');setRestoreSource('windows');}
function setRestoreSource(which){
  if(state.restoreSource!==which)clearRestoreInspection();
  state.restoreSource=which;document.querySelectorAll('.source-tab').forEach(b=>b.classList.toggle('active',b.dataset.source===which));
  $('restoreWindowsSource').classList.toggle('hidden',which!=='windows');$('restoreLinuxSource').classList.toggle('hidden',which!=='linux');
  $('inspectRestoreBtn').disabled=which==='windows'?!$('restoreFile').files.length:!state.restoreLinuxSelectedPath;
  if(which==='linux')loadRestoreArchiveList($('restoreLinuxPath').value);
}

async function uploadRestoreFile(file){
  const started=await api('api/upload.php?action=start',{method:'POST',body:JSON.stringify({name:file.name,size:file.size})});
  const id=started.upload_id, chunkSize=started.chunk_bytes||8388608; let offset=0;
  $('uploadProgress').classList.remove('hidden');
  while(offset<file.size){
    const chunk=file.slice(offset,Math.min(file.size,offset+chunkSize));
    const response=await fetch('api/upload.php?action=chunk',{method:'PUT',credentials:'same-origin',headers:{'X-CSRF-Token':csrf,'X-Upload-Id':id,'X-Chunk-Offset':String(offset)},body:chunk});
    const data=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));if(!response.ok||!data.ok)throw new Error(data.error||'Upload failed.');
    offset=data.received;const pct=Math.floor(offset/file.size*100);$('uploadFill').style.width=`${pct}%`;$('uploadText').textContent=`Uploading ${formatBytes(offset)} of ${formatBytes(file.size)} (${pct}%)`;
  }
  const done=await api('api/upload.php?action=finish',{method:'POST',body:JSON.stringify({upload_id:id})});
  $('uploadFill').style.width='100%';$('uploadText').textContent=`Upload complete — SHA-256 ${done.sha256}`;state.restoreUploadId=id;return done;
}

async function loadRestoreArchiveList(path,preselectPath=null){
  const box=$('restoreArchiveList');box.innerHTML='<div class="restore-empty">Loading archives…</div>';state.restoreLinuxSelectedPath=null;$('inspectRestoreBtn').disabled=true;
  try{
    const data=await api(`api/list.php?path=${encodeURIComponent(path)}`);const files=data.entries.filter(e=>!e.is_dir&&archiveSuffix.test(e.name));box.innerHTML='';
    for(const e of files){const full=pathJoin(path,e.name);const row=document.createElement('button');row.type='button';row.className='restore-archive-row';row.dataset.tip=`Select ${e.name} for inspection before restore`;row.innerHTML=`<span class="restore-selected-mark" aria-hidden="true">○</span><span class="fileicon file archive">${e.name.toLowerCase().endsWith('.zip')?'ZIP':'TAR'}</span><span class="restore-archive-name">${escapeHtml(e.name)}</span><span>${formatBytes(e.size)}</span><span>${formatModified(e.modified)}</span>`;row.setAttribute('aria-pressed','false');row.onclick=()=>{clearRestoreInspection();document.querySelectorAll('.restore-archive-row.selected').forEach(x=>{x.classList.remove('selected');x.setAttribute('aria-pressed','false');x.querySelector('.restore-selected-mark').textContent='○';});row.classList.add('selected');row.setAttribute('aria-pressed','true');row.querySelector('.restore-selected-mark').textContent='✓';state.restoreLinuxSelectedPath=full;$('inspectRestoreBtn').disabled=false;};box.appendChild(row);if(preselectPath&&full===preselectPath){row.click();}}
    if(!files.length)box.innerHTML='<div class="restore-empty">No supported tar or ZIP archives found in this folder.</div>';
  }catch(err){box.innerHTML=`<div class="restore-empty error">${escapeHtml(err.message)}</div>`;}
}

async function inspectRestore(){
  // A second inspection is a real action, not a silently disabled button.
  // Invalidate an old plan before rechecking so a failed check cannot restore stale data.
  clearRestoreInspection();
  $('restoreStatus').textContent='Inspecting archive…';
  $('inspectRestoreBtn').textContent='Inspecting…';
  try{
    let payload={action:'inspect'};
    if(state.restoreSource==='windows'){
      const file=$('restoreFile').files[0];if(!file)throw new Error('Choose an archive from Windows first.');
      if(!state.restoreUploadId)await uploadRestoreFile(file);payload.upload_id=state.restoreUploadId;
    }else{if(!state.restoreLinuxSelectedPath)throw new Error('Select a Linux archive first.');payload.linux_path=state.restoreLinuxSelectedPath;}
    const data=await api('api/restore.php',{method:'POST',body:JSON.stringify(payload)});state.restorePlan=data;
    const m=data.manifest||{};const paths=(data.selected_paths||[]).map(p=>`<li>${escapeHtml(p)}</li>`).join('');
    $('restorePreview').innerHTML=`<div class="preview-banner ${data.critical?'critical':''}"><strong>${data.critical?'⚠ Critical system restore':'✓ Archive verified for restore'}</strong></div><dl class="preview-grid"><dt>Archive</dt><dd>${escapeHtml(data.archive)}</dd><dt>SHA-256</dt><dd><code>${escapeHtml(data.sha256)}</code></dd><dt>Created by</dt><dd>${escapeHtml(m.product||'')} ${escapeHtml(m.product_version||'')}</dd><dt>Source host</dt><dd>${escapeHtml(m.hostname||'Unknown')}</dd><dt>Source system</dt><dd>${escapeHtml(m.os||'Unknown')} / ${escapeHtml(m.architecture||'Unknown')}</dd><dt>Archive entries</dt><dd>${data.member_count}${data.member_count_truncated?'+' : ''}</dd><dt>Existing selected roots</dt><dd>${data.existing_selected_roots}</dd><dt>New selected roots</dt><dd>${data.missing_selected_roots}</dd></dl>${data.cross_machine?`<div class="warningbox"><strong>Different Linux machine.</strong> This archive was created on ${escapeHtml(m.hostname||'Unknown')} but is being inspected on ${escapeHtml(data.destination_hostname||'Unknown')}. Restore will write the original absolute Linux paths on THIS machine. Verify the target carefully and type RESTORE to continue.</div>`:''}${data.fidelity_warning?`<div class="warningbox">${escapeHtml(data.fidelity_warning)}</div>`:''}<div class="preview-paths"><strong>Original restore locations</strong><ul>${paths}</ul></div>`;
    $('restorePreview').classList.remove('hidden');$('continueRestoreBtn').classList.remove('hidden');
    $('inspectRestoreBtn').disabled=false;$('inspectRestoreBtn').textContent='Inspect Again';
    $('inspectRestoreBtn').dataset.tip='Recheck the selected archive and refresh the restore preview. No files are changed.';
    $('restoreStatus').textContent='Archive inspection passed. You may inspect again or continue to Restore.';
  }catch(err){
    $('inspectRestoreBtn').disabled=false;$('inspectRestoreBtn').textContent='Retry Inspection';
    $('inspectRestoreBtn').dataset.tip='Retry archive verification after the inspection failed';
    $('restoreStatus').textContent=`Inspection failed: ${err.message}`;toast(err.message,7000);
  }
}

function openRestoreConfirmation(){
  if(!state.restorePlan)return;const p=state.restorePlan;
  $('restoreAcknowledge').checked=false;$('restoreConfirmText').value='';$('criticalConfirmBox').classList.toggle('hidden',!(p.critical||p.cross_machine));$('confirmRestoreBtn').disabled=true;
  $('restoreConfirmSummary').innerHTML=`<div><b>Archive:</b> ${escapeHtml(p.archive)}</div><div><b>Restore locations:</b> ${(p.selected_paths||[]).length}</div><div><b>Existing selected roots:</b> ${p.existing_selected_roots}</div><div><b>Critical system paths:</b> ${p.critical?'YES':'No'}</div>${p.cross_machine?`<div><b>Different source machine:</b> ${escapeHtml(p.manifest?.hostname||'Unknown')} → ${escapeHtml(p.destination_hostname||'Unknown')} (type RESTORE)</div>`:''}`;
  showModal('restoreConfirmModal');
}
function updateRestoreConfirm(){const ok=$('restoreAcknowledge').checked&&(!(state.restorePlan?.critical||state.restorePlan?.cross_machine)||$('restoreConfirmText').value==='RESTORE');$('confirmRestoreBtn').disabled=!ok;}

async function queueRestore(){
  try{
    hideModal('restoreConfirmModal');hideModal('restoreModal');showModal('progressModal');$('progressModalTitle').textContent='Restore Archive';$('progressTitle').textContent='Preparing restore…';$('progressMessage').textContent='Creating the protected restore job.';$('stageFill').style.width='5%';
    const data=await api('api/restore.php',{method:'POST',body:JSON.stringify({action:'queue',plan_id:state.restorePlan.plan_id,confirmed:true,confirmation_text:(state.restorePlan.critical||state.restorePlan.cross_machine)?'RESTORE':''})});
    const job=await watchJob(data.job_id,j=>applyProgress(j,'Restoring'));
    hideModal('progressModal');state.lastRestoreJob=job;await discardRestoreUpload();await refreshAfterLinuxMutation({containers:[state.currentPath],tree:true});showRestoreResult(job);
  }catch(err){hideModal('progressModal');toast(err.message,8000);}
}
function showRestoreResult(job){
  const success=job.status==='completed',isRollback=job.kind==='rollback';$('restoreResultHeading').textContent=isRollback?(success?'Rollback Complete':'Rollback Failed'):(success?'Restore Complete':'Restore Failed');$('restoreResultBanner').className='resultbanner '+(success?'success':'error');$('restoreResultTitle').textContent=isRollback?(success?'Rollback completed and verified':'Rollback did not complete'):(success?'Restore completed and verified':'Restore did not complete');$('restoreResultText').textContent=job.message||'';$('restoreRollbackPath').textContent=job.rollback_bundle||'—';$('restoreResultStatus').textContent=job.status||'—';$('rollbackRestoreBtn').style.display=success&&!isRollback?'inline-block':'none';const w=$('restoreResultWarning');if(!success){w.textContent=job.rollback_error?'Automatic rollback also reported a problem. Review the audit log before making more changes.':'The pre-restore safety snapshot was automatically restored when possible.';w.classList.remove('hidden');}else w.classList.add('hidden');showModal('restoreResultModal');
}

async function queueRollback(){
  try{hideModal('rollbackConfirmModal');hideModal('restoreResultModal');showModal('progressModal');$('progressModalTitle').textContent='Rollback Restore';$('progressTitle').textContent='Preparing rollback…';$('progressMessage').textContent='Loading the pre-restore safety package.';$('stageFill').style.width='8%';const data=await api('api/restore.php',{method:'POST',body:JSON.stringify({action:'rollback',job_id:state.historyRollbackId||state.lastRestoreJob.id,confirmed:true,confirmation_text:'ROLLBACK'})});const job=await watchJob(data.job_id,j=>applyProgress(j,'Rolling back'));hideModal('progressModal');state.lastRestoreJob=job;state.historyRollbackId=null;await refreshAfterLinuxMutation({containers:[state.currentPath],tree:true});showRestoreResult(job);}catch(err){hideModal('progressModal');toast(err.message,8000);}
}


async function openRestoreHistory(){
  showModal('restoreHistoryModal');await refreshRestoreHistory();
}
async function restoreHistoryAction(action,id,extra={}){
  return api('api/restore.php',{method:'POST',body:JSON.stringify({action,job_id:id,...extra})});
}
async function refreshRestoreHistory(){
  const area=$('restoreHistoryItems');area.textContent='Loading Restore History…';
  try{
    const data=await api('api/restore.php',{method:'POST',body:JSON.stringify({action:'history'})});
    area.innerHTML='';
    $('restoreHistoryPolicy').textContent=`Automatic cleanup: up to ${data.retention_count} unprotected backups for up to ${data.retention_days} days, with a ${formatBytes(data.retention_bytes)} soft limit. Failed and protected backups are never automatically deleted.`;
    if(!data.history.length){area.textContent='No retained Restore safety backups.';return;}
    for(const h of data.history){
      const row=document.createElement('div');row.className='restore-history-item';
      const details=document.createElement('div');details.className='restore-history-info';
      const title=document.createElement('strong');title.textContent=new Date(h.created_at*1000).toLocaleString();
      const info=document.createElement('small');info.textContent=`${h.status}${h.rolled_back?' · Rolled back':''}${h.protected?' · Protected':''} · ${formatBytes(h.size_bytes)}`;
      const paths=document.createElement('small');paths.textContent=h.paths.join(', ')||'No original paths recorded';
      details.append(title,info,paths);row.appendChild(details);
      const actions=document.createElement('div');actions.className='restore-history-actions';
      const historyTips={
        Verify:'Check that this rollback backup is intact and readable. No files are changed.',
        Rollback:'Restore files to their condition before this restore. Confirmation is required.',
        Protect:'Keep this backup until you manually unprotect it.',
        Unprotect:'Allow automatic cleanup of this backup when it meets the retention rules.',
        Delete:'Permanently delete this rollback backup after confirmation. Restored files are not deleted.'
      };
      // Unavailable actions are status labels, not silent disabled buttons.
      // The reason is visible in the label and explained on hover/focus.
      const add=(label,fn,disabled=false,danger=false,reason='')=>{
        if(disabled){
          const status=document.createElement('span');status.className='restore-history-unavailable';
          status.textContent=reason.startsWith('Already')?'Already rolled back':`${label} unavailable`;
          status.dataset.tip=reason||`${label} is unavailable for this backup`;
          status.tabIndex=0;status.setAttribute('role','status');actions.appendChild(status);return;
        }
        const b=document.createElement('button');b.type='button';b.textContent=label;
        b.className=danger?'dangeroutline':'secondarybtn';b.dataset.tip=historyTips[label]||label;
        b.onclick=fn;actions.appendChild(b);
      };
      add('Verify',async()=>{try{await restoreHistoryAction('history-verify',h.id);toast('Rollback backup SHA-256 and TAR verification passed.');}catch(e){toast(e.message,7000);}},!h.usable,false,'The safety archive is missing or no longer usable.');
      add('Rollback',()=>{state.historyRollbackId=h.id;$('rollbackConfirmText').value='';$('confirmRollbackBtn').disabled=true;hideModal('restoreHistoryModal');showModal('rollbackConfirmModal');},h.status!=='completed'||h.rolled_back||!h.usable,false,h.rolled_back?'Already rolled back. This restore cannot be undone a second time.':'Rollback requires a completed restore and an intact safety archive.');
      add(h.protected?'Unprotect':'Protect',async()=>{try{await restoreHistoryAction('history-protect',h.id,{protected:!h.protected});await refreshRestoreHistory();}catch(e){toast(e.message,7000);}},h.critical||h.status!=='completed',false,'Critical and failed-recovery backups must remain protected.');
      add('Delete',()=>{state.historyDeleteId=h.id;$('restoreHistoryDeleteTarget').textContent=title.textContent+' — '+paths.textContent;$('restoreHistoryDeleteText').value='';$('confirmHistoryDeleteBtn').disabled=true;showModal('restoreHistoryDeleteModal');},h.status!=='completed'||h.protected,true,h.protected?'Unprotect an eligible backup before deleting it.':'Only completed, unprotected safety backups may be deleted.');
      row.appendChild(actions);area.appendChild(row);
    }
    return true;
  }catch(e){area.textContent=`Unable to load Restore History: ${e.message}`;return false;}
}
async function confirmRestoreHistoryDelete(){
  if($('restoreHistoryDeleteText').value!=='DELETE'||!state.historyDeleteId)return;
  try{await restoreHistoryAction('history-delete',state.historyDeleteId,{confirmation_text:'DELETE'});hideModal('restoreHistoryDeleteModal');state.historyDeleteId=null;await refreshRestoreHistory();toast('Rollback package deleted.');}
  catch(e){toast(e.message,7000);}
}

function isAdmin() { return state.settings.role === 'admin'; }

function contextButton(label, action, opts={}) {
  const btn=document.createElement('button');
  btn.type='button'; btn.className='contextitem'+(opts.danger?' danger':''); btn.textContent=label;btn.dataset.tip=opts.tip||label;
  if(opts.disabled){btn.disabled=true;}
  else btn.onclick=async()=>{hideContextMenu();try{await action();}catch(err){toast(err.message,6500);}};
  return btn;
}
function contextSeparator(){const d=document.createElement('div');d.className='contextsep';return d;}
function contextCloseHeader(){
  const head=document.createElement('div');head.className='contextmenu-head';
  const title=document.createElement('span');title.textContent='File actions';
  const close=document.createElement('button');close.type='button';close.className='contextmenu-close';
  close.textContent='×';close.setAttribute('aria-label','Close file actions');
  close.dataset.tip='Close this menu without changing files';
  close.onclick=()=>hideContextMenu();head.append(title,close);return head;
}
function clearContextTarget(){document.querySelectorAll('.filetable tbody tr.context-target').forEach(row=>row.classList.remove('context-target'));}
function hideContextMenu(){const m=$('contextMenu');if(m)m.classList.add('hidden');clearContextTarget();}
function positionContextMenu(x,y){dismissTooltip();const m=$('contextMenu');m.classList.remove('hidden');const r=m.getBoundingClientRect();m.style.left=`${Math.min(x,window.innerWidth-r.width-8)}px`;m.style.top=`${Math.min(y,window.innerHeight-r.height-8)}px`;}
function addPathToArchiveSelection(path,entry){
  toggleSelection(path,entry,true); toast(`${entry.name} added to archive selection.`);
}
function showContextMenu(x,y,path,entry){
  clearContextTarget();const target=[...document.querySelectorAll('.filetable tbody tr[data-path]')].find(row=>row.dataset.path===path);if(target)target.classList.add('context-target');
  state.contextPath=path;state.contextEntry=entry;const m=$('contextMenu');m.innerHTML='';m.appendChild(contextCloseHeader());
  if(entry.protected){
    if(entry.is_dir)m.appendChild(contextButton('Open',()=>navigate(path),{tip:'Browse this virtual system location read-only.'}));
    m.appendChild(contextButton('Virtual system location (read-only)',()=>{},{disabled:true,tip:'Browsing is allowed, but archive selection and file changes are disabled under /proc, /sys, /dev and /run.'}));
    m.appendChild(contextSeparator());
    m.appendChild(contextButton('Properties',()=>openProperties(path)));
    positionContextMenu(x,y);
    return;
  }
  if(entry.is_dir)m.appendChild(contextButton('Open',()=>navigate(path)));
  if(isEditableTextCandidate(entry)){
    if(isAdmin())m.appendChild(contextButton('Open / Edit Text…',()=>openTextEditor(path),{tip:'Attempt to open this regular file as UTF-8 text; binary/non-text files are safely refused'}));
    else m.appendChild(contextButton('Open / Edit Text… (Admin required)',()=>{}, {disabled:true,tip:'Administrator access required. Editing files is available only to Administrator accounts.'}));
  }
  if(!entry.is_dir&&isArchiveName(entry.name)){
    m.appendChild(contextButton('Open / View Archive',()=>openArchivePath(path)));
    m.appendChild(contextButton('Verify Archive',()=>verifyArchivePath(path)));
    if(isAdmin())m.appendChild(contextButton('Restore…',()=>openRestoreForPath(path)));
    m.appendChild(contextButton('Copy SHA-256',()=>copyArchiveSha(path)));
    m.appendChild(contextSeparator());
  }
  if(!entry.is_dir)m.appendChild(contextButton('Download / Save to Windows',()=>downloadPathToWindows(path)));
  m.appendChild(contextButton('Add to Archive Selection',()=>addPathToArchiveSelection(path,entry),{disabled:!entry.selectable}));
  m.appendChild(contextSeparator());
  if(isAdmin())m.appendChild(contextButton('Copy',()=>setFileClipboard(path,'copy'),{tip:'Copy this item to another Linux folder after you choose Paste. Does not copy to Windows.'}));
  if(isAdmin())m.appendChild(contextButton('Cut',()=>setFileClipboard(path,'move'),{tip:'Prepare to move this item to another Linux folder. The original remains until you successfully Paste.'}));
  if(isAdmin()&&state.clipboard){
    const mode=state.clipboard.mode==='move'?'Move':'Copy';
    m.appendChild(contextButton(`Paste Here (${mode})`,()=>pasteFileClipboard(state.currentPath),{tip:`Paste into the current Linux directory: ${state.currentPath}`}));
    if(entry.is_dir)m.appendChild(contextButton(`Paste Into Folder (${mode})`,()=>pasteFileClipboard(path),{tip:`Paste into this specific Linux folder: ${path}`}));
  }
  if(isAdmin())m.appendChild(contextButton('Rename…',()=>openRename(path)));
  if(isAdmin())m.appendChild(contextButton('Delete…',()=>openDelete(path,entry.name),{danger:true}));
  m.appendChild(contextSeparator());
  m.appendChild(contextButton('Properties',()=>openProperties(path)));
  positionContextMenu(x,y);
}
function showBackgroundContextMenu(x,y){
  const m=$('contextMenu');m.innerHTML='';m.appendChild(contextCloseHeader());
  m.appendChild(contextButton('Refresh',()=>navigate(state.currentPath,false)));
  if(isAdmin()&&state.clipboard)m.appendChild(contextButton(`Paste Here (${state.clipboard.mode==='move'?'Move':'Copy'})`,()=>pasteFileClipboard(state.currentPath),{tip:`Paste into the current Linux directory: ${state.currentPath}`}));
  if(isAdmin()){m.appendChild(contextButton('New Folder…',()=>createNewFolder(state.currentPath)));m.appendChild(contextButton('New File…',()=>createNewFile(state.currentPath)));}
  positionContextMenu(x,y);
}


function matchingLastSavedReview(){
  const review=state.lastSavedReview;
  return review && review.path===state.editor.path && review.sha256===state.editor.sha256 ? review : null;
}
function updateEditorLines(){
  const text=$('editorText').value;
  const lines=Math.max(1,text.split('\n').length);
  $('editorLines').textContent=Array.from({length:lines},(_,i)=>i+1).join('\n');
  state.editor.dirty=text!==state.editor.original;
  $('editorStatus').textContent=state.editor.dirty?'Unsaved changes.':'No unsaved changes.';
  const lastSaved=!state.editor.dirty && matchingLastSavedReview();
  $('editorReviewBtn').textContent=lastSaved?'Review Last Save':'Review Changes';
  $('editorReviewBtn').setAttribute('data-tip',lastSaved?'Compare this file before and after its last save in this browser session':'Compare the file as opened with your current unsaved edits');
}
function syncEditorScroll(){$('editorLines').scrollTop=$('editorText').scrollTop;}
async function openTextEditor(path){if(!isAdmin())throw new Error('Administrator permission is required to edit Linux files.');const data=await api(`api/file.php?action=read-text&path=${encodeURIComponent(path)}`);state.editor={path:data.path,original:data.content,sha256:data.sha256,lineEnding:data.line_ending||'lf',bom:!!data.bom,critical:!!data.critical,dirty:false};$('editorTitle').textContent=`Edit ${data.name}`;$('editorPath').textContent=data.path;$('editorText').value=data.content;$('editorSearch').value='';$('editorMeta').textContent=`${data.owner}:${data.group}  ${data.mode_octal}  ${formatBytes(data.size_bytes)}  ${data.line_ending==='crlf'?'CRLF':'LF'}`;$('editorCriticalWarning').classList.toggle('hidden',!data.critical);$('editorStatus').textContent='No changes.';updateEditorLines();showModal('editorModal');setTimeout(()=>$('editorText').focus(),30);}
function closeTextEditor(){if(state.editor.dirty&&!window.confirm('Discard unsaved changes to this file?'))return false;hideModal('editorModal');state.editor={path:null,original:'',sha256:'',lineEnding:'lf',bom:false,critical:false,dirty:false};return true;}
function findEditorNext(){const q=$('editorSearch').value;if(!q)return;const ta=$('editorText'),text=ta.value.toLocaleLowerCase(),needle=q.toLocaleLowerCase();let at=text.indexOf(needle,Math.max(ta.selectionEnd,0));if(at<0)at=text.indexOf(needle,0);if(at<0){toast('Text not found.');return;}ta.focus();ta.setSelectionRange(at,at+q.length);}
let reviewChangedLines=[];
let reviewChangePosition=-1;
function reviewEditorChanges(){
  const lastSave=!state.editor.dirty ? matchingLastSavedReview() : null;
  const original=lastSave ? lastSave.before : state.editor.original;
  const current=lastSave ? lastSave.after : $('editorText').value;
  $('reviewBeforeLabel').textContent=lastSave?'Before last save':'Original';
  $('reviewAfterLabel').textContent=lastSave?'After last save':'Current';
  const a=original.split('\n'),b=current.split('\n');
  reviewChangedLines=[];reviewChangePosition=-1;
  for(let i=0;i<Math.max(a.length,b.length);i++)if(a[i]!==b[i])reviewChangedLines.push(i);
  const highlighted=(lines)=>lines.map((content,line)=>reviewChangedLines.includes(line)?`<span class="review-changed-line">${escapeHtml(content)||' '}</span>`:escapeHtml(content)).join('\n');
  $('editorOriginalReview').innerHTML=highlighted(a);
  $('editorCurrentReview').innerHTML=highlighted(b);
  $('editorReviewSummary').textContent=reviewChangedLines.length?`${reviewChangedLines.length} changed line position(s). The first change is highlighted below.`:(lastSave?'No differences found in last saved edit.':'No unsaved changes.');
  $('reviewPrev').disabled=!reviewChangedLines.length;
  $('reviewNext').disabled=!reviewChangedLines.length;
  showModal('editorReviewModal');
  $('editorOriginalReview').scrollTop=0;$('editorCurrentReview').scrollTop=0;
  $('editorOriginalReview').scrollLeft=0;$('editorCurrentReview').scrollLeft=0;
  // Modal layout must settle before measuring the scrollable pre viewport.
  if(reviewChangedLines.length)requestAnimationFrame(()=>goToReviewChange(1));
}
function goToReviewChange(direction){
  if(!reviewChangedLines.length)return;
  reviewChangePosition=(reviewChangePosition+direction+reviewChangedLines.length)%reviewChangedLines.length;
  const line=reviewChangedLines[reviewChangePosition];
  // Computed line-height is used instead of assuming 12px/1.45 CSS never changes.
  const pane=$('editorCurrentReview');const lh=parseFloat(getComputedStyle(pane).lineHeight)||17.4;
  const target=Math.max(0,line*lh-lh*3);
  for(const id of ['editorOriginalReview','editorCurrentReview'])$(id).scrollTop=target;
  $('editorReviewSummary').textContent=`Change ${reviewChangePosition+1} of ${reviewChangedLines.length} — line ${line+1}`;
}
let reviewSyncing=false;
function synchronizeReviewPanes(source,destination){
  if(reviewSyncing)return;reviewSyncing=true;
  destination.scrollTop=source.scrollTop;destination.scrollLeft=source.scrollLeft;
  reviewSyncing=false;
}

async function saveTextEditor(){if(!state.editor.path)return;const content=$('editorText').value;if(content===state.editor.original){toast('No changes to save.');return;}let confirmation='';if(state.editor.critical){confirmation=window.prompt('WARNING: This is a protected system file. A safety backup will be created. Type SAVE to continue:','')||'';if(confirmation!=='SAVE')throw new Error('Save cancelled; type SAVE exactly for protected system files.');}$('editorSaveBtn').disabled=true;$('editorStatus').textContent='Creating safety backup and saving…';try{const editedPath=state.editor.path;const data=await api('api/file.php',{method:'POST',body:JSON.stringify({action:'write-text',path:editedPath,content,expected_sha256:state.editor.sha256,line_ending:state.editor.lineEnding,bom:state.editor.bom,confirmation_text:confirmation})});state.lastSavedReview={path:editedPath,before:state.editor.original,after:content,sha256:data.sha256};state.editor.original=content;state.editor.sha256=data.sha256;state.editor.dirty=false;$('editorStatus').textContent=`Saved safely. Backup: ${data.backup_path}`;toast('File saved. A protected pre-edit backup was created.');removeSelectedPath(editedPath);state.selectionAnchor=null;closeTextEditor();await refreshAfterLinuxMutation({containers:[parentPath(editedPath)]});removeSelectedPath(editedPath);state.selectionAnchor=null;refreshSelectionState();}finally{$('editorSaveBtn').disabled=false;}}

let propertiesRequestId=0;
async function openProperties(path){
  const requestId=++propertiesRequestId;
  const data=await api(`api/file.php?action=properties&path=${encodeURIComponent(path)}`);
  if(requestId!==propertiesRequestId)return;
  const rows=[['Name',data.name],['Path',data.path],['Type',data.is_dir?'Folder':data.is_symlink?'Symbolic link':'File'],['Size',data.is_dir?'Calculating…':formatBytes(data.size)],['Modified',formatModified(data.modified)],['Permissions',`${data.mode} (${data.mode_octal})`],['Owner',`${data.owner} (${data.uid})`],['Group',`${data.group} (${data.gid})`],['Critical system path',data.critical?'Yes':'No']];
  if(data.is_symlink)rows.push(['Link target',data.link_target||'']);
  $('propertiesBody').innerHTML=rows.map(([k,v])=>`<div><b>${escapeHtml(k)}</b><span>${escapeHtml(v??'')}</span></div>`).join('');
  if(data.is_dir)$('propertiesBody').children[3].querySelector('span').dataset.folderSize='1';
  showModal('propertiesModal');
  if(data.is_dir){
    try{
      const estimate=await api('api/estimate.php',{method:'POST',body:JSON.stringify({paths:[path]})});
      if(requestId!==propertiesRequestId||$('propertiesModal').classList.contains('hidden'))return;
      const cell=$('propertiesBody').querySelector('[data-folder-size]');
      if(cell)cell.textContent=estimate.complete?formatBytes(estimate.bytes):`≥ ${formatBytes(estimate.bytes)} (partial estimate; scan limit reached)`;
    }catch(err){
      if(requestId!==propertiesRequestId||$('propertiesModal').classList.contains('hidden'))return;
      const cell=$('propertiesBody').querySelector('[data-folder-size]');
      if(cell)cell.textContent=`Size unavailable: ${err.message}`;
    }
  }
}

async function openArchivePath(path){
  const data=await api(`api/file.php?action=archive&mode=list&path=${encodeURIComponent(path)}`);state.archiveContextPath=path;
  $('archiveContentTitle').textContent=data.name;$('archiveEntries').innerHTML=(data.entries||[]).map(x=>`<div class="archiveentry">${escapeHtml(x)}</div>`).join('');$('archiveEntryCount').textContent=`${(data.entries||[]).length} entries${data.truncated?' (first entries shown)':''}`;
  if($('archiveVerifyStatus')){$('archiveVerifyStatus').textContent=`SHA-256: ${data.sha256}`;$('archiveVerifyStatus').className='archive-verify-status';}
  showModal('archiveModal');
}
async function verifyArchivePath(path){
  const data=await api(`api/file.php?action=archive&mode=verify&path=${encodeURIComponent(path)}`);
  state.archiveContextPath=path;
  if(!$('archiveModal').classList.contains('hidden')){$('archiveVerifyStatus').textContent=`✓ Verified — SHA-256 ${data.sha256}`;$('archiveVerifyStatus').className='archive-verify-status verified';}
  toast(`Archive verified. SHA-256: ${data.sha256}`,6500);
  return data;
}
async function copyArchiveSha(path){const data=await api(`api/file.php?action=archive&mode=info&path=${encodeURIComponent(path)}`);try{await navigator.clipboard.writeText(data.sha256);toast('SHA-256 copied.');}catch{toast(`SHA-256: ${data.sha256}`,7000);}}
async function openRestoreForPath(path){
  if(!isAdmin()){toast('Administrator permission is required for Restore.');return;}
  resetRestore();state.restoreSource='linux';state.restoreLinuxSelectedPath=path;$('restoreLinuxPath').value=parentPath(path);showModal('restoreModal');setRestoreSource('linux');
  await loadRestoreArchiveList(parentPath(path),path);
}

async function stagePathDownload(path){return api('api/file.php',{method:'POST',body:JSON.stringify({action:'stage-download',path})});}
function explainWindowsFileNameError(err,name){
  // Chromium intentionally restricts some native Windows filenames/extensions,
  // including .ini and .cfg; do not rename automatically or bypass browser policy.
  if(err instanceof TypeError&&/Name is not allowed/i.test(err.message||'')){
    const e=new Error(`Chrome cannot write “${name}” directly into this Windows folder. Nothing was overwritten; Linux Archive Explorer will use a normal browser download when possible.`);e.browserDownloadFallback=true;return e;
  }
  return err;
}
async function getExistingWindowsFile(dir,name){
  try{return await dir.getFileHandle(name);}catch(err){
    if(err.name==='NotFoundError'||err.name==='TypeMismatchError')return null;
    throw explainWindowsFileNameError(err,name);
  }
}
async function getExistingWindowsFolder(dir,name){
  try{return await dir.getDirectoryHandle(name);}catch(err){
    if(err.name==='NotFoundError'||err.name==='TypeMismatchError')return null;
    throw explainWindowsFileNameError(err,name);
  }
}
async function uniqueWindowsName(dir,name,isFolder){
  const idx=name.lastIndexOf('.'),stem=!isFolder&&idx>0?name.slice(0,idx):name,ext=!isFolder&&idx>0?name.slice(idx):'';
  for(let i=2;i<=1001;i++){
    const test=`${stem} (${i})${ext}`;
    if(!(await getExistingWindowsFile(dir,test))&&!(await getExistingWindowsFolder(dir,test)))return test;
  }
  throw new Error('No free Keep Both name in the selected Windows folder.');
}
async function chooseWindowsConflict(dir,name,isFolder=false){
  const existingFile=await getExistingWindowsFile(dir,name);
  const existingFolder=await getExistingWindowsFolder(dir,name);
  if(!existingFile&&!existingFolder)return {name,choice:'error'};
  const choice=await showConflictDialog(`Windows: ${name}`,isFolder,!!existingFile&&!isFolder,!!existingFolder);
  if(choice.choice==='cancel')throw new TransferCancelled();
  if(choice.choice==='skip')return {name,choice:'skip'};
  if(choice.choice==='keep-both')return {name:await uniqueWindowsName(dir,name,isFolder),choice:'keep-both'};
  if(choice.choice==='merge'&&isFolder&&existingFolder)return {name,choice:'merge'};
  if(choice.choice==='replace'&&!isFolder)return {name,choice:'replace'};
  throw new Error('The chosen action is not valid for this Windows item.');
}
async function saveStagedJobToHandle(job,dirHandle,filename,allowReplace=false){
  const existing=await getExistingWindowsFile(dirHandle,filename);
  if(existing&&!allowReplace)throw new Error(`Windows file ${filename} changed during transfer; no file was overwritten.`);
  let fh;
  try{fh=existing||await dirHandle.getFileHandle(filename,{create:true});}
  catch(err){throw explainWindowsFileNameError(err,filename);}
  const writable=await fh.createWritable();
  try{
    const response=await fetch(`api/download.php?id=${encodeURIComponent(job.job_id||job.id)}`,{credentials:'same-origin'});
    if(!response.ok)throw new Error(`Download failed (${response.status}).`);
    if(response.body&&response.body.pipeTo)await response.body.pipeTo(writable);
    else{const blob=await response.blob();await writable.write(blob);await writable.close();}
  }catch(err){try{await writable.abort();}catch{}throw err;}
}

function requestBrowserDownload(jobId){
  // One browser download, no extra window or folder picker; the server releases its staged copy after streaming.
  window.location.href=`api/download.php?id=${encodeURIComponent(jobId)}`;
}
async function downloadPathToWindows(path){
  const staged=await stagePathDownload(path);
  requestBrowserDownload(staged.job_id);
  toast('Download requested. Save the file when your browser prompts.');
}

function setFileClipboard(path,mode){state.clipboard={paths:[path],mode};toast(`${mode==='move'?'Ready to move':'Ready to copy'} ${baseName(path)}. Choose Paste in the destination folder.`);}
function setSelectedClipboard(mode){
  if(!isAdmin())return;
  const paths=[...state.selected.keys()];if(!paths.length){toast('Select Linux items using checkboxes first.');return;}
  state.clipboard={paths,mode};toast(`${paths.length} selected item(s) ready to ${mode==='move'?'move':'copy'}. Open the destination folder and choose Paste.`);
}
async function criticalConfirmation(word,message){const typed=window.prompt(`${message}\n\nType ${word} to continue:`,'');if(typed===null)throw new Error('Operation cancelled.');if(typed!==word)throw new Error(`Operation cancelled because ${word} was not entered.`);return word;}
async function pathProperties(path){return api(`api/file.php?action=properties&path=${encodeURIComponent(path)}`);}
async function fileOperationConfirmation(action,source,destination){
  const dest=await api(`api/file.php?action=transfer-destination-info&path=${encodeURIComponent(destination)}`);
  let critical=!!dest.critical;
  if(action==='move'){const src=await pathProperties(source);critical=critical||!!src.critical;}
  if(!critical)return '';
  const word=action.toUpperCase();
  return criticalConfirmation(word,`WARNING — ${word} will write into ${destination}. This is a critical Linux system/application path. Moving or writing the wrong file can make services or the system unusable.`);
}
async function pasteFileClipboard(destination){
  if(!state.clipboard)return;
  const pending=[...state.clipboard.paths],action=state.clipboard.mode==='move'?'move':'copy';
  resetTransferConflictPolicy();
  let completed=0;
  try{
    for(const source of pending){
      const confirmation=await fileOperationConfirmation(action,source,destination);
      const info=await transferTargetInfo(destination,baseName(source));
      const props=await pathProperties(source);
      let decision='error';
      if(info.exists){
        const choice=await showConflictDialog(info.path,props.is_dir,info.is_regular_file,action==='copy');
        if(choice.choice==='cancel')throw new TransferCancelled();
        if(choice.choice==='skip')continue;
        if(choice.choice==='merge'&&action!=='copy')throw new Error('Moving into an existing folder requires Keep Both, Skip, or Cancel.');
        decision=choice.choice;
      }
      const data=await api('api/file.php',{method:'POST',body:JSON.stringify({action,sources:[source],destination,confirmation_text:confirmation,conflict_action:decision})});
      showModal('progressModal');$('progressModalTitle').textContent=action==='move'?'Move Item':'Copy Item';
      const job=await watchJob(data.job_id,j=>applyProgress(j,action==='move'?'Moving':'Copying'));
      hideModal('progressModal');
      if(job.status==='failed')throw new Error(job.error||job.message||`${action} failed`);
      completed++;
      const newPath=(job.target_paths||data.target_paths||[])[0]||pathJoin(destination,baseName(source));
      const containers=[destination];const renamed=[];
      if(action==='move'){
        state.clipboard.paths=state.clipboard.paths.filter(p=>p!==source);
        renamed.push({oldPath:source,newPath});containers.push(parentPath(source));
      }
      await refreshAfterLinuxMutation({containers,renamed,tree:true});
    }
    if(action==='move'&&!state.clipboard.paths.length)state.clipboard=null;
    toast(`${action==='move'?'Move':'Copy'} completed for ${completed} item(s).`);
  }catch(err){hideModal('progressModal');if(err instanceof TransferCancelled){toast('Paste cancelled. Existing files were not overwritten.');return;}throw err;}
}

async function createNewFolder(destination){const name=window.prompt('New folder name:','New Folder');if(!name)return;const props=await api(`api/file.php?action=transfer-destination-info&path=${encodeURIComponent(destination)}`);const confirmation=props.critical?await criticalConfirmation('CREATE','WARNING — This folder will be created inside a critical Linux system/application path.'):'';await api('api/file.php',{method:'POST',body:JSON.stringify({action:'mkdir',destination,relative_path:name,confirmation_text:confirmation})});toast('Folder created.');await refreshAfterLinuxMutation({containers:[destination],tree:true});}

async function createNewFile(destination){
  const name=window.prompt('New empty file name (for example notes.txt):','notes.txt');
  if(name===null||!name.trim())return;
  const info=await api(`api/file.php?action=transfer-destination-info&path=${encodeURIComponent(destination)}`);
  const confirmation=info.critical?await criticalConfirmation('CREATE','WARNING — You are creating a file inside a critical system/application location.'):'';
  const result=await api('api/file.php',{method:'POST',body:JSON.stringify({action:'make-file',destination,name:name.trim(),confirmation_text:confirmation})});
  toast(`Created ${baseName(result.path)}.`);
  await refreshAfterLinuxMutation({containers:[destination],tree:true});
}

function openRename(path){state.renamePath=path;$('renameInput').value=baseName(path);showModal('renameModal');setTimeout(()=>$('renameInput').select(),20);}
async function confirmRename(){const name=$('renameInput').value.trim();if(!name)return;const oldPath=state.renamePath;const props=await pathProperties(oldPath);const confirmation=props.critical?await criticalConfirmation('RENAME','WARNING — You are renaming a critical Linux system/application path.'):'';const data=await api('api/file.php',{method:'POST',body:JSON.stringify({action:'rename',path:oldPath,new_name:name,confirmation_text:confirmation})});hideModal('renameModal');toast(`Renamed to ${baseName(data.path)}.`);await refreshAfterLinuxMutation({containers:[parentPath(oldPath),parentPath(data.path)],renamed:[{oldPath,newPath:data.path}],tree:true});}
async function openDelete(path,name){state.deletePath=path;const props=await api(`api/file.php?action=properties&path=${encodeURIComponent(path)}`);state.deleteCritical=!!props.critical;$('deleteMessage').textContent=`Are you sure you want to delete “${name}”?`;$('deleteCriticalBox').classList.toggle('hidden',!state.deleteCritical);$('deleteConfirmText').value='';$('confirmDeleteBtn').disabled=state.deleteCritical;showModal('deleteModal');}
async function confirmDelete(){const target=state.deletePath;const confirmation=state.deleteCritical?$('deleteConfirmText').value:'';const data=await api('api/file.php',{method:'POST',body:JSON.stringify({action:'delete',path:target,confirmation_text:confirmation})});hideModal('deleteModal');toast(`Item moved to protected trash.`);await refreshAfterLinuxMutation({containers:[parentPath(target)],removed:[target],tree:true});return data;}

async function loadSettings(){
  const data=await api('api/settings.php');state.settings=data.settings||state.settings;
  state.sourceHostname=String(state.settings.hostname||'linux');
  if($('sessionTimeoutSetting'))$('sessionTimeoutSetting').value=String(state.settings.session_timeout||1800);
  if($('defaultFormatSetting'))$('defaultFormatSetting').value=state.settings.default_format||'tar.gz';
  if($('archiveFormat')&&!$('archiveFormat').dataset.userChanged)$('archiveFormat').value=state.settings.default_format||'tar.gz';
  scheduleSessionExpiry();
  return state.settings;
}
async function saveSettings(){const timeout=Number($('sessionTimeoutSetting').value),format=$('defaultFormatSetting').value;const data=await api('api/settings.php',{method:'POST',body:JSON.stringify({session_timeout:timeout,default_format:format})});state.settings.session_timeout=data.session_timeout;state.settings.default_format=data.default_format;$('archiveFormat').value=data.default_format;scheduleSessionExpiry();toast('Application defaults saved.');}
const storageAreas = [
  ['staging','Temporary staging','staging', 'Temporary files; active work cannot be cleared'],
  ['uploads','Uploads','uploads','Finished/abandoned uploads only; active transfers cannot be cleared'],
  ['jobs','Job records','jobs','Finished job history only; recovery-linked records are kept'],
  ['trash','Deleted-file recovery','rollback/trash','Only eligible unprotected deleted-file copies'],
  ['edits','Edit recovery','rollback/edits','Only eligible unprotected file-edit copies'],
  ['restore','Restore History backups','rollback/restore-history','Protected, failed and recovery-required backups remain'],
  ['ui','Legacy UI recovery','rollback/ui','Only legacy application-owned UI recovery snapshots'],
  ['installer','Installer recovery','rollback/installer','Removes even the LAST verified installer recovery point; use only after acceptance'],
];
async function loadStorage(){
  if(!isAdmin()||!$('storageSummary'))return;
  const data=await api('api/storage.php');
  const s=data.storage||{},sizes=s.sizes||{};
  $('storageSummary').textContent=`Free disk: ${formatBytes(s.disk_free)}; safety reserve: ${formatBytes(s.required_reserve)}. Protected recovery and permanent archives are not removed by Reset.`;
  const panel=$('storageAreas');if(!panel)return;
  panel.replaceChildren();
  for(const [scope,title,key,tip] of storageAreas){
    const row=document.createElement('div');row.className='storage-area';
    const label=document.createElement('span');label.className='storage-label';label.textContent=title;
    const size=document.createElement('span');size.className='storage-size';size.textContent=formatBytes(sizes[key]||0);
    const btn=document.createElement('button');btn.type='button';btn.className='dangeroutline tinybtn';btn.textContent='Clear…';btn.dataset.tip=tip;
    btn.disabled=!(sizes[key]>0);
    btn.onclick=()=>clearStorage(scope,title).catch(err=>toast(err.message,7000));
    row.append(label,size,btn);panel.appendChild(row);
  }
  const info=document.createElement('div');info.className='storage-area';
  const permanent=document.createElement('span');permanent.className='storage-label';permanent.textContent='Saved Linux archives';
  const archiveSize=document.createElement('span');archiveSize.className='storage-size';archiveSize.textContent=formatBytes(sizes.archives||0);
  const note=document.createElement('span');note.className='storage-protected';note.textContent='Manage in Explorer';
  info.append(permanent,archiveSize,note);panel.appendChild(info);
}
async function clearStorage(scope,title){
  if(!isAdmin()||!storageAreas.some(x=>x[0]===scope))return;
  const phrase='CLEAR '+scope.toUpperCase();
  const special=scope==='installer'?' WARNING: this deletes your last verified installer rollback. It cannot be recovered from this application.':'';
  const answer=window.prompt(`Clear eligible files from ${title}? Active and protected recovery is preserved.${special} Type ${phrase} to continue:`);
  if(answer!==phrase)return;
  await api('api/storage.php',{method:'POST',body:JSON.stringify({action:'clear',scope,confirmation:phrase})});
  await loadStorage();toast(`${title}: eligible files cleaned.`);
}
async function resetStorage(){
  if(!isAdmin())return;
  const answer=window.prompt('Reset eligible temporary files and unprotected recovery copies? Permanent archives, configuration, accounts and protected recovery are preserved. Type RESET to continue:');
  if(answer!=='RESET')return;
  $('storageResetBtn').disabled=true;
  try{await api('api/storage.php',{method:'POST',body:JSON.stringify({action:'reset',confirmation:'RESET'})});await loadStorage();toast('Eligible temporary storage and recovery copies cleaned.');}
  finally{$('storageResetBtn').disabled=false;}
}
async function loadUsers(){
  if(!$('userList'))return;const data=await api('api/users.php');state.users=data.users||[];state.currentUsername=data.current_username||state.settings.username||'';
  const activeAdmins=state.users.filter(u=>u.role==='admin'&&u.enabled).length;const box=$('userList');box.innerHTML='';
  for(const u of state.users){
    const isCurrent=u.username===state.currentUsername;const isLastAdmin=u.role==='admin'&&u.enabled&&activeAdmins===1;const row=document.createElement('div');row.className='userrow';
    row.innerHTML=`<span><strong>${escapeHtml(u.username)}</strong><small>${escapeHtml(u.role)} · ${u.enabled?'Enabled':'Disabled'}${isCurrent?' · Current account':''}</small></span><span class="useractions"></span>`;
    const actions=row.querySelector('.useractions');
    if(!isCurrent){const edit=document.createElement('button');edit.type='button';edit.className='secondarybtn tinybtn edituser';edit.textContent='Edit';edit.dataset.tip='Edit this account role or enabled status';edit.onclick=()=>openUserEditor({...u,_isCurrent:false,_isLastAdmin:isLastAdmin});actions.appendChild(edit);const reset=document.createElement('button');reset.type='button';reset.className='secondarybtn tinybtn resetuser';reset.textContent='Reset Password';reset.dataset.tip='Set a new password for this account';reset.onclick=()=>openResetUserPassword(u.username);actions.appendChild(reset);}
    if(!isCurrent&&!isLastAdmin){const del=document.createElement('button');del.type='button';del.className='dangeroutline tinybtn deleteuser';del.textContent='Delete';del.dataset.tip='Delete this account after confirmation';del.onclick=()=>deleteUser(u.username);actions.appendChild(del);}
    else {const note=document.createElement('span');note.className='user-safety-note';note.textContent=isCurrent?'Current account': 'Required admin';note.title=isCurrent?'The account currently signed in cannot be deleted here.':'The last enabled Administrator cannot be deleted.';actions.appendChild(note);}
    box.appendChild(row);
  }
  if(!box.children.length)box.textContent='No users found.';
}
function openUserEditor(user=null){
  state.userEditing=user?.username||null;$('userModalTitle').textContent=user?'Edit User':'Add User';$('userNameInput').value=user?.username||'';$('userNameInput').readOnly=!!user;$('userRoleInput').value=user?.role||'user';$('userEnabledInput').checked=user?!!user.enabled:true;$('userPasswordInput').value='';$('userPasswordConfirmInput').value='';
  const editing=!!user;const locked=!!(user?._isCurrent||user?._isLastAdmin);for(const id of ['userPasswordLabel','userPasswordInput','userPasswordConfirmLabel','userPasswordConfirmInput'])$(id).classList.toggle('hidden',editing);$('userRoleInput').disabled=locked;$('userEnabledInput').disabled=locked;
  const guard=$('userEditGuard');guard.classList.toggle('hidden',!locked);guard.textContent=locked?'The account currently in use / required Administrator cannot be disabled or demoted here. Use My Account above to change your own password.':'';
  showModal('userModal');setTimeout(()=>$(user?'userRoleInput':'userNameInput').focus(),30);
}
async function saveUser(){
  const username=$('userNameInput').value.trim(),role=$('userRoleInput').value,enabled=$('userEnabledInput').checked,password=state.userEditing?'':$('userPasswordInput').value,passwordConfirm=state.userEditing?'':$('userPasswordConfirmInput').value;
  if(!state.userEditing&&password.length<8)throw new Error('New users require a password of at least 8 characters.');
  if(!state.userEditing&&password!==passwordConfirm)throw new Error('Initial passwords do not match.');
  await api('api/users.php',{method:'POST',body:JSON.stringify({action:'save',username,role,enabled,password})});hideModal('userModal');toast(`User ${username} saved.`);await loadUsers();
}
function openResetUserPassword(username){state.userPasswordTarget=username;$('resetUserName').textContent=username;$('resetUserPassword').value='';$('resetUserPasswordConfirm').value='';showModal('userPasswordModal');setTimeout(()=>$('resetUserPassword').focus(),30);}
async function resetUserPassword(){const username=state.userPasswordTarget,newp=$('resetUserPassword').value,confirm=$('resetUserPasswordConfirm').value;if(!username)return;if(newp!==confirm)throw new Error('New passwords do not match.');if(newp.length<8)throw new Error('Password must be at least 8 characters.');const data=await api('api/users.php',{method:'POST',body:JSON.stringify({action:'reset-password',username,new_password:newp,confirm_password:confirm})});hideModal('userPasswordModal');state.userPasswordTarget=null;toast(data.message||`Password reset for ${username}.`);}
async function deleteUser(username){if(!window.confirm(`Delete Linux Archive Explorer user “${username}”?`))return;await api('api/users.php',{method:'POST',body:JSON.stringify({action:'delete',username})});toast(`User ${username} deleted.`);await loadUsers();}

async function openTransfer(){
  state.transferLinuxPath=state.currentPath;state.transferLinuxSelected.clear();state.transferLinuxAnchor=null;state.transferWindowsSelected.clear();state.transferWindowsAnchor=null;
  $('transferStatus').textContent=isAdmin()?'Drag items between Linux and Windows panes to copy. Choose Folder first to authorize a Windows destination.':'Browse Linux and copy Linux items to Windows. Administrator permission is required for Windows → Linux writes.';
  const drop=$('transferLinuxDrop');if(drop){drop.contentEditable=isAdmin()?'true':'false';drop.setAttribute('aria-disabled',isAdmin()?'false':'true');drop.classList.toggle('transfer-readonly',!isAdmin());drop.dataset.tip=isAdmin()?'Press Ctrl+V to paste copied files from Windows Explorer, or drag and drop files/folders here from Windows Explorer.':'Administrator permission is required to write Windows files into Linux.';}
  showModal('transferModal');await Promise.all([refreshTransferLinux(),ensureTransferWindows(false)]);updateTransferSelectionUI();
}
function transferMap(side){return side==='linux'?state.transferLinuxSelected:state.transferWindowsSelected;}
function transferEntries(side){return side==='linux'?state.transferLinuxEntries:state.transferWindowsEntries;}
function transferAnchor(side){return side==='linux'?state.transferLinuxAnchor:state.transferWindowsAnchor;}
function setTransferAnchor(side,value){if(side==='linux')state.transferLinuxAnchor=value;else state.transferWindowsAnchor=value;}
function transferKey(side,item){return side==='linux'?item.path:item.name;}
function updateTransferSelectionUI(){
  const lc=state.transferLinuxSelected.size,wc=state.transferWindowsSelected.size;
  if($('transferLinuxCount'))$('transferLinuxCount').textContent=`${lc} selected`;
  if($('transferWindowsCount'))$('transferWindowsCount').textContent=`${wc} selected`;
  if($('transferToLinux')){$('transferToLinux').disabled=!isAdmin()||wc===0;$('transferToLinux').textContent=wc?`← To Linux (${wc})`:'← To Linux';$('transferToLinux').dataset.tip=isAdmin()?'Copy selected Windows items into the open Linux folder':'Administrator permission is required to write Windows files into Linux';}
  if($('transferToWindows')){$('transferToWindows').disabled=lc===0;$('transferToWindows').textContent=lc?`To Windows (${lc}) →`:'To Windows →';}
  for(const side of ['linux','windows']){
    const all=$(side==='linux'?'transferLinuxSelectAll':'transferWindowsSelectAll');if(!all)continue;const entries=(transferEntries(side)||[]).filter(item=>side!=='linux'||(!item.protected&&item.selectable!==false)),map=transferMap(side);all.checked=entries.length>0&&map.size===entries.length;all.indeterminate=map.size>0&&map.size<entries.length;all.disabled=entries.length===0;
  }
}
function clearTransferSelection(side){transferMap(side).clear();setTransferAnchor(side,null);const box=$(side==='linux'?'transferLinuxList':'transferWindowsList');if(box)box.querySelectorAll('.transferitem').forEach(r=>{r.classList.remove('selected');const cb=r.querySelector('.transfercheck');if(cb)cb.checked=false;});updateTransferSelectionUI();}
function transferSelectable(side,item){return side!=='linux'||(!item.protected&&item.selectable!==false);}
function applyTransferRange(side,index,checked=true){const entries=transferEntries(side),map=transferMap(side),anchor=transferAnchor(side);if(anchor===null||anchor<0||anchor>=entries.length)return false;for(let i=Math.min(anchor,index);i<=Math.max(anchor,index);i++){const item=entries[i];if(!transferSelectable(side,item))continue;const key=transferKey(side,item);if(checked)map.set(key,item);else map.delete(key);}return true;}
function selectTransferItem(side,item,index,ev,fromCheckbox=false){
  if(!transferSelectable(side,item)){if(fromCheckbox)ev.target.checked=false;return;}
  const map=transferMap(side),key=transferKey(side,item);const desired=fromCheckbox?ev.target.checked:!map.has(key);
  if(ev.shiftKey&&applyTransferRange(side,index,true)){}else if(fromCheckbox||ev.ctrlKey||ev.metaKey){if(desired)map.set(key,item);else map.delete(key);setTransferAnchor(side,index);}else{map.clear();map.set(key,item);setTransferAnchor(side,index);}
  renderTransferSelectionState(side);updateTransferSelectionUI();
}
function renderTransferSelectionState(side){const box=$(side==='linux'?'transferLinuxList':'transferWindowsList'),map=transferMap(side);if(!box)return;box.querySelectorAll('.transferitem').forEach(row=>{const key=row.dataset.key;const selected=map.has(key);row.classList.toggle('selected',selected);const cb=row.querySelector('.transfercheck');if(cb)cb.checked=selected;});}
function buildTransferRow(side,item,index){
  const row=document.createElement('div');row.className='transferitem';row.tabIndex=0;const key=transferKey(side,item);row.dataset.key=key;
  const isDir=side==='linux'?item.is_dir:item.kind==='directory';const size=side==='linux'?(isDir?'Folder':formatBytes(item.size)):(isDir?'Folder':'File');const icon=side==='linux'?fileIcon(item):`<span class="fileicon ${isDir?'folder':'file'}">${isDir?'📁':'FILE'}</span>`;
  row.innerHTML=`<input class="transfercheck" type="checkbox" aria-label="Select ${escapeHtml(item.name)}" data-tip="Select or deselect ${escapeHtml(item.name)}">${icon}<span>${escapeHtml(item.name)}</span><small>${size}</small>`;
  if(isDir){row.querySelector('.fileicon').title='Double-click to open folder';row.children[2].title='Double-click to open folder';}
  // Drag copies only; prevent protected Linux virtual/system paths from becoming drag sources.
  const protectedEntry=side==='linux'&&Boolean(item.protected);
  row.draggable=!protectedEntry;row.dataset.isDir=isDir?'1':'0';row.dataset.side=side;
  if(protectedEntry)row.classList.add('transfer-protected');
  row.addEventListener('dragstart',ev=>startTransferPaneDrag(ev,side,item));
  row.addEventListener('dragend',endTransferPaneDrag);
  const cb=row.querySelector('.transfercheck');if(protectedEntry||item.selectable===false)cb.disabled=true;cb.addEventListener('click',ev=>{ev.stopPropagation();selectTransferItem(side,item,index,ev,true);});
  row.addEventListener('click',ev=>{if(ev.target.closest('.transfercheck'))return;selectTransferItem(side,item,index,ev,false);});
  row.addEventListener('keydown',ev=>{if(!transferSelectable(side,item))return;if(ev.key===' '){ev.preventDefault();selectTransferItem(side,item,index,ev,false);}else if(ev.key==='Enter'&&isDir){ev.preventDefault();row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));}});
  if(isDir)row.addEventListener('dblclick',async ev=>{ev.preventDefault();if(!transferSelectable(side,item))return;if(side==='linux'){state.transferLinuxPath=item.path;state.transferLinuxSelected.clear();state.transferLinuxAnchor=null;await refreshTransferLinux();}else{state.transferWindowsStack.push({handle:item.handle,name:item.name});state.transferWindowsSelected.clear();state.transferWindowsAnchor=null;await refreshTransferWindows();}});
  if(side==='linux'&&!isDir&&isEditableTextCandidate(item))row.addEventListener('dblclick',ev=>{ev.preventDefault();if(!transferSelectable(side,item))return;if(!isAdmin()){toast('Administrator access required. Editing files is available only to Administrator accounts.',6500);return;}openTextEditor(item.path).catch(err=>toast(err.message,6500));});
  row.addEventListener('contextmenu',ev=>{ev.preventDefault();ev.stopPropagation();showTransferContextMenu(ev.clientX,ev.clientY,side,item);});
  return row;
}
function transferContextItems(side,item){
  const map=transferMap(side),key=transferKey(side,item);
  return map.has(key)&&map.size>1?[...map.values()]:[item];
}
function setTransferClipboard(side,items,mode){
  if(side==='linux'){
    const blocked=items.find(item=>item.protected);
    if(blocked)throw new Error(`Protected Linux item cannot be ${mode==='move'?'cut':'copied'}: ${blocked.name}`);
    state.transferClipboard={side,mode,items:items.map(item=>({...item}))};
  }else{
    const dir=transferWindowsCurrent();
    if(!dir)throw new Error('Choose a Windows folder first.');
    state.transferClipboard={side,mode,items:items.map(item=>({name:item.name,kind:item.kind,handle:item.handle,sourceDir:dir}))};
  }
  toast(`${items.length} ${side==='linux'?'Linux':'Windows'} item(s) ready to ${mode==='move'?'move':'copy'}. Choose Paste in either Transfer pane.`);
}
function transferPasteLabel(destinationSide,into=false){
  const clip=state.transferClipboard;if(!clip)return '';
  const verb=clip.mode==='move'?'Move':'Copy';
  const from=clip.side===destinationSide?'':` from ${clip.side==='linux'?'Linux':'Windows'}`;
  return `${into?'Paste Into Folder':'Paste Here'} (${verb}${from})`;
}
async function copyWindowsHandleWithinWindows(item,destDir,nameOverride=null){
  const isFolder=item.kind==='directory',wanted=nameOverride||item.name;
  const picked=await chooseWindowsConflict(destDir,wanted,isFolder);
  if(picked.choice==='skip')return {copied:false,complete:false,name:picked.name};
  if(isFolder){
    const target=await destDir.getDirectoryHandle(picked.name,{create:true});
    let complete=true;
    for await(const [name,child] of item.handle.entries()){
      const childResult=await copyWindowsHandleWithinWindows({name,kind:child.kind,handle:child},target,name);
      if(!childResult.complete)complete=false;
    }
    return {copied:true,complete,name:picked.name};
  }
  let fh;
  try{fh=await destDir.getFileHandle(picked.name,{create:true});}
  catch(err){throw explainWindowsFileNameError(err,picked.name);}
  const writable=await fh.createWritable();
  try{const file=await item.handle.getFile();await writable.write(file);await writable.close();}
  catch(err){try{await writable.abort();}catch{}throw err;}
  return {copied:true,complete:true,name:picked.name};
}
async function windowsDirectoryContainsHandle(root,target,depth=0){
  if(!root||!target||root.kind!=='directory'||target.kind!=='directory'||depth>64)return false;
  if(root.isSameEntry&&await root.isSameEntry(target))return true;
  for await(const [,child] of root.entries()){
    if(child.kind==='directory'&&await windowsDirectoryContainsHandle(child,target,depth+1))return true;
  }
  return false;
}
async function pasteWindowsItemsWithinWindows(clip,destDir){
  resetTransferConflictPolicy();
  if(!destDir)throw new Error('Choose a Windows destination folder first.');
  if(!(await ensureWindowsPermission()))throw new Error('Windows folder permission is no longer available. Choose Folder again.');
  let completed=0,incomplete=0;
  for(const item of [...clip.items]){
    if(item.kind==='directory'&&await windowsDirectoryContainsHandle(item.handle,destDir))throw new Error(`Cannot paste ${item.name} into itself or one of its own subfolders.`);
    const result=await copyWindowsHandleWithinWindows(item,destDir);
    if(!result.copied||!result.complete){incomplete++;continue;}
    if(clip.mode==='move'){
      await item.sourceDir.removeEntry(item.name,{recursive:item.kind==='directory'});
      clip.items=clip.items.filter(x=>x!==item);
    }
    completed++;
  }
  if(clip.mode==='move'&&!clip.items.length)state.transferClipboard=null;
  await refreshTransferWindows();
  toast(`${clip.mode==='move'?'Move':'Copy'} completed for ${completed} Windows item(s).${incomplete?' Incomplete/skipped item(s) were left at the source.':''}`);
}
async function pasteLinuxItemsWithinLinux(clip,destination){
  const pending=[...clip.items],action=clip.mode==='move'?'move':'copy';
  resetTransferConflictPolicy();
  let completed=0,skipped=0;
  try{
    for(const item of pending){
      const source=item.path;
      const confirmation=await fileOperationConfirmation(action,source,destination);
      const info=await transferTargetInfo(destination,baseName(source));
      const props=await pathProperties(source);
      let decision='error';
      if(info.exists){
        const choice=await showConflictDialog(info.path,props.is_dir,info.is_regular_file,action==='copy');
        if(choice.choice==='cancel')throw new TransferCancelled();
        if(choice.choice==='skip'){skipped++;continue;}
        if(choice.choice==='merge'&&action!=='copy')throw new Error('Moving into an existing folder requires Keep Both, Skip, or Cancel.');
        decision=choice.choice;
      }
      const data=await api('api/file.php',{method:'POST',body:JSON.stringify({action,sources:[source],destination,confirmation_text:confirmation,conflict_action:decision})});
      showModal('progressModal');$('progressModalTitle').textContent=action==='move'?'Move Item':'Copy Item';
      const job=await watchJob(data.job_id,j=>applyProgress(j,action==='move'?'Moving':'Copying'));
      hideModal('progressModal');
      if(job.status==='failed')throw new Error(job.error||job.message||`${action} failed`);
      completed++;
      const newPath=(job.target_paths||data.target_paths||[])[0]||pathJoin(destination,baseName(source));
      const containers=[destination],renamed=[];
      if(action==='move'){
        clip.items=clip.items.filter(x=>x!==item);
        renamed.push({oldPath:source,newPath});containers.push(parentPath(source));
      }
      await refreshAfterLinuxMutation({containers,renamed,tree:true});
    }
    if(action==='move'&&!clip.items.length)state.transferClipboard=null;
    toast(`${action==='move'?'Move':'Copy'} completed for ${completed} Linux item(s).${skipped?' Skipped item(s) remain at the source.':''}`);
  }catch(err){
    hideModal('progressModal');
    if(err instanceof TransferCancelled){toast('Paste cancelled. Existing files were not overwritten.');return;}
    throw err;
  }
}
async function removeLinuxTransferSource(item){
  const props=await pathProperties(item.path);
  const confirmation=props.critical?await criticalConfirmation('DELETE','WARNING — A successful Windows copy is complete. Removing the original will delete a critical Linux system/application path into protected trash.'):'';
  await api('api/file.php',{method:'POST',body:JSON.stringify({action:'delete',path:item.path,confirmation_text:confirmation})});
  await refreshAfterLinuxMutation({containers:[parentPath(item.path)],removed:[item.path],tree:true});
}
async function pasteTransferClipboard(destinationSide,destination){
  const clip=state.transferClipboard;if(!clip)return;
  if(state.transferDropBusy)throw new Error('A transfer is already running.');
  state.transferDropBusy=true;
  try{
    if(clip.side==='linux'&&destinationSide==='linux')return await pasteLinuxItemsWithinLinux(clip,destination);
    if(clip.side==='windows'&&destinationSide==='windows')return await pasteWindowsItemsWithinWindows(clip,destination);
    if(clip.side==='windows'&&destinationSide==='linux'){
      const result=await copyWindowsItemsToLinux([...clip.items],destination);
      if(clip.mode==='move'){
        const remaining=[];
        for(const r of result.itemResults){
          if(r.complete)await r.item.sourceDir.removeEntry(r.item.name,{recursive:r.item.kind==='directory'});
          else remaining.push(r.item);
        }
        clip.items=remaining;
        if(!remaining.length)state.transferClipboard=null;
        await refreshTransferWindows();
        $('transferStatus').textContent=remaining.length?'Windows → Linux copy completed, but incomplete/skipped source item(s) were retained.':'Windows → Linux move completed.';
      }
      return;
    }
    if(clip.side==='linux'&&destinationSide==='windows'){
      const result=await copyLinuxItemsToWindows([...clip.items],destination);
      if(clip.mode==='move'){
        const remaining=[];
        for(const r of result.itemResults){
          if(r.complete)await removeLinuxTransferSource(r.item);else remaining.push(r.item);
        }
        clip.items=remaining;
        if(!remaining.length)state.transferClipboard=null;
        $('transferStatus').textContent=remaining.length?'Linux → Windows copy completed, but incomplete/skipped source item(s) were retained.':'Linux → Windows move completed.';
      }
      return;
    }
  }finally{state.transferDropBusy=false;}
}
async function renameWindowsTransferItem(item){
  const dir=transferWindowsCurrent();if(!dir)throw new Error('Choose a Windows folder first.');
  const name=window.prompt('New name:',item.name);if(!name||name===item.name)return;
  if(/[\\/:*?"<>|]/.test(name)||name==='.'||name==='..')throw new Error('That Windows name is not allowed.');
  const existingFile=await getExistingWindowsFile(dir,name),existingFolder=await getExistingWindowsFolder(dir,name);
  if(existingFile||existingFolder)throw new Error('An item with that name already exists.');
  const result=await copyWindowsHandleWithinWindows(item,dir,name);
  if(!result.complete)throw new Error('Rename copy was incomplete; the original was left unchanged.');
  await dir.removeEntry(item.name,{recursive:item.kind==='directory'});
  await refreshTransferWindows();toast(`Renamed to ${name}.`);
}
async function deleteWindowsTransferItems(items){
  const dir=transferWindowsCurrent();if(!dir)throw new Error('Choose a Windows folder first.');
  const label=items.length===1?`“${items[0].name}”`:`${items.length} selected items`;
  if(!window.confirm(`Delete ${label} from Windows? This uses the browser's authorized folder access and does not create a Linux Archive Explorer recovery copy.`))return;
  for(const item of items)await dir.removeEntry(item.name,{recursive:item.kind==='directory'});
  clearTransferSelection('windows');await refreshTransferWindows();toast('Windows item(s) deleted.');
}
function showTransferContextMenu(x,y,side,item){
  const items=transferContextItems(side,item),m=$('contextMenu');m.innerHTML='';m.appendChild(contextCloseHeader());
  if(side==='linux'){
    if(item.protected){m.appendChild(contextButton('Protected system/application folder',()=>{},{disabled:true}));m.appendChild(contextSeparator());m.appendChild(contextButton('Properties',()=>openProperties(item.path)));positionContextMenu(x,y);return;}
    if(item.is_dir)m.appendChild(contextButton('Open',async()=>{state.transferLinuxPath=item.path;await refreshTransferLinux();}));
    if(items.length===1&&isEditableTextCandidate(item)){
      if(isAdmin())m.appendChild(contextButton('Open / Edit Text…',()=>openTextEditor(item.path),{tip:'Open this regular Linux file in the protected UTF-8 editor; binary files are refused'}));
      else m.appendChild(contextButton('Open / Edit Text… (Admin required)',()=>{}, {disabled:true,tip:'Administrator access required. Editing files is available only to Administrator accounts.'}));
    }
    m.appendChild(contextButton('Copy',()=>setTransferClipboard('linux',items,'copy')));
    if(isAdmin())m.appendChild(contextButton('Cut',()=>setTransferClipboard('linux',items,'move')));
    if(isAdmin()&&state.transferClipboard){m.appendChild(contextButton(transferPasteLabel('linux'),()=>pasteTransferClipboard('linux',state.transferLinuxPath)));if(item.is_dir)m.appendChild(contextButton(transferPasteLabel('linux',true),()=>pasteTransferClipboard('linux',item.path)));}
    if(isAdmin()&&items.length===1)m.appendChild(contextButton('Rename…',()=>openRename(item.path)));
    if(isAdmin()&&items.length===1)m.appendChild(contextButton('Delete…',()=>openDelete(item.path,item.name),{danger:true}));
    m.appendChild(contextSeparator());m.appendChild(contextButton('Properties',()=>openProperties(item.path)));
  }else{
    if(item.kind==='directory')m.appendChild(contextButton('Open',async()=>{state.transferWindowsStack.push({handle:item.handle,name:item.name});await refreshTransferWindows();}));
    m.appendChild(contextButton('Copy',()=>setTransferClipboard('windows',items,'copy')));
    m.appendChild(contextButton('Cut',()=>setTransferClipboard('windows',items,'move')));
    if(state.transferClipboard){m.appendChild(contextButton(transferPasteLabel('windows'),()=>pasteTransferClipboard('windows',transferWindowsCurrent())));if(item.kind==='directory')m.appendChild(contextButton(transferPasteLabel('windows',true),()=>pasteTransferClipboard('windows',item.handle)));}
    if(items.length===1)m.appendChild(contextButton('Rename…',()=>renameWindowsTransferItem(item)));
    m.appendChild(contextButton('Delete…',()=>deleteWindowsTransferItems(items),{danger:true}));
  }
  positionContextMenu(x,y);
}
function showTransferBackgroundContextMenu(x,y,side){
  const m=$('contextMenu');m.innerHTML='';m.appendChild(contextCloseHeader());
  m.appendChild(contextButton('Refresh',()=>side==='linux'?refreshTransferLinux():refreshTransferWindows()));
  if(state.transferClipboard&&(side!=='linux'||isAdmin())){
    m.appendChild(contextSeparator());
    const destination=side==='linux'?state.transferLinuxPath:transferWindowsCurrent();
    m.appendChild(contextButton(transferPasteLabel(side),()=>pasteTransferClipboard(side,destination)));
  }
  positionContextMenu(x,y);
}
async function refreshTransferLinux(){
  $('transferLinuxPath').textContent=state.transferLinuxPath;const box=$('transferLinuxList');box.innerHTML='<div class="transfer-empty">Loading…</div>';state.transferLinuxSelected.clear();state.transferLinuxAnchor=null;
  try{const data=await api(`api/list.php?path=${encodeURIComponent(state.transferLinuxPath)}`);state.transferLinuxEntries=(data.entries||[]).map(e=>({...e,path:pathJoin(state.transferLinuxPath,e.name)}));box.innerHTML='';state.transferLinuxEntries.forEach((e,i)=>box.appendChild(buildTransferRow('linux',e,i)));if(!box.children.length)box.innerHTML='<div class="transfer-empty">This folder is empty.</div>';if(box.dataset.renderedPath!==state.transferLinuxPath){box.scrollTop=0;box.scrollLeft=0;}box.dataset.renderedPath=state.transferLinuxPath;updateTransferSelectionUI();}catch(err){box.innerHTML=`<div class="transfer-empty error">${escapeHtml(err.message)}</div>`;state.transferLinuxEntries=[];updateTransferSelectionUI();}
}
async function ensureTransferWindows(allowPicker=false){
  if(!directWindowsSupported()){
    transferWindowsMessage('Direct Windows folder browsing is unavailable in this browser. Select Linux files and click To Windows to download, or paste/drag Windows files into Linux.');
    return false;
  }
  if(!state.windowsHandle){const epoch=state.windowsAccessGeneration;const restored=await loadStoredHandle();if(epoch!==state.windowsAccessGeneration)return false;if(!state.windowsHandle)state.windowsHandle=restored;}
  if(!state.windowsHandle){
    transferWindowsMessage('No Windows folder selected. Click Choose Folder for direct folder browsing, or use browser downloads, Ctrl+V, or drag-and-drop.');
    return false;
  }
  // Query only. Never display stale remembered files as if browser permission survived restart.
  if(!(await ensureWindowsPermission())){
    await forgetTransferWindows('Previous Windows folder permission is no longer available. Click Choose Folder to select an accessible folder. Browser downloads and Ctrl+V / drag-and-drop still work.');
    return false;
  }
  if(!state.transferWindowsRoot||state.transferWindowsRoot!==state.windowsHandle){
    state.transferWindowsRoot=state.windowsHandle;
    state.transferWindowsStack=[{handle:state.windowsHandle,name:state.windowsHandle.name}];
  }
  return await refreshTransferWindows();
}
function transferWindowsCurrent(){return state.transferWindowsStack.length?state.transferWindowsStack[state.transferWindowsStack.length-1].handle:null;}
function transferWindowsDisplayPath(){return state.transferWindowsStack.map(x=>x.name).join('\\');}
async function refreshTransferWindows(){
  const dir=transferWindowsCurrent();if(!dir){transferWindowsMessage('Choose a Windows folder to browse it, or use browser downloads and Windows Explorer Ctrl+V / drag-and-drop.');return false;}
  $('transferWindowsPath').textContent=transferWindowsDisplayPath();const box=$('transferWindowsList');box.innerHTML='<div class="transfer-empty">Loading…</div>';state.transferWindowsSelected.clear();state.transferWindowsAnchor=null;
  try{
    const items=[];for await(const [name,handle] of dir.entries())items.push({name,handle,kind:handle.kind});
    items.sort((a,b)=>a.kind===b.kind?a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}):(a.kind==='directory'?-1:1));
    state.transferWindowsEntries=items;box.innerHTML='';items.forEach((item,i)=>box.appendChild(buildTransferRow('windows',item,i)));
    if(!items.length)box.innerHTML='<div class="transfer-empty">This Windows folder is empty.</div>';
    if(state.transferWindowsRenderedHandle!==dir){box.scrollTop=0;box.scrollLeft=0;}
    state.transferWindowsRenderedHandle=dir;
    $('transferStatus').textContent='Drag files or folders between panes to copy. Windows browsing is limited to the folder you authorized.';
    updateTransferSelectionUI();return true;
  }catch(err){
    const msg=windowsAccessMessage(err);
    await forgetTransferWindows(msg);return false;
  }
}
function selectAllTransfer(side,checked){const map=transferMap(side);map.clear();if(checked)for(const item of transferEntries(side))map.set(transferKey(side,item),item);renderTransferSelectionState(side);updateTransferSelectionUI();}
// Conflict selection is required for each existing destination. Optional Apply to
// Remaining lasts only for this transfer batch and never spans future jobs.
let transferConflictSticky = null;
let pendingConflictResolver = null;
class TransferCancelled extends Error { constructor(){super('Transfer cancelled.');this.name='TransferCancelled';} }
function resetTransferConflictPolicy(){transferConflictSticky=null;}
function resolveConflictDialog(choice){
  if(!pendingConflictResolver)return;
  const done=pendingConflictResolver;pendingConflictResolver=null;
  const apply=$('conflictApplyRemaining').checked;
  hideModal('conflictModal');done({choice,apply});
}
async function showConflictDialog(path,isFolder,isFile,allowMerge=true){
  const sticky=transferConflictSticky;
  if(sticky&&sticky.isFolder===isFolder&&!(sticky.choice==='replace'&&!isFile)&&!(sticky.choice==='merge'&&!allowMerge))return sticky;
  $('conflictMessage').textContent=`${path} already exists. ${isFolder?'Choose Merge Folder to copy into the existing directory, or Keep Both to make a separate folder.':path.startsWith('Windows: ')?'Replace overwrites the existing Windows file after your approval; choose Keep Both to preserve it.':'Choose Replace to preserve the old Linux file in protected recovery before replacing it, or Keep Both for another filename.'}`;
  $('conflictReplaceBtn').classList.toggle('hidden',isFolder||!isFile);
  $('conflictMergeBtn').classList.toggle('hidden',!isFolder||!allowMerge);
  $('conflictApplyRemaining').checked=false;
  const progressWasVisible=!$('progressModal').classList.contains('hidden');
  if(progressWasVisible)hideModal('progressModal');
  showModal('conflictModal');
  const decision=await new Promise(resolve=>{pendingConflictResolver=resolve;});
  if(progressWasVisible)showModal('progressModal');
  if(decision.apply&&decision.choice!=='cancel')transferConflictSticky={...decision,isFolder};
  return decision;
}
async function transferTargetInfo(destination,relativePath){
  return api(`api/file.php?action=transfer-target-info&destination=${encodeURIComponent(destination)}&relative_path=${encodeURIComponent(relativePath)}`);
}
async function transferConflictChoice(destination,relativePath,isFolder=false){
  const info=await transferTargetInfo(destination,relativePath);
  if(!info.exists)return {decision:'error',relativePath};
  const picked=await showConflictDialog(info.path,isFolder,info.is_regular_file);
  if(picked.choice==='cancel')throw new TransferCancelled();
  if(picked.choice==='skip')return {decision:'skip',relativePath};
  if(picked.choice==='merge'){
    if(!isFolder||!info.is_directory)throw new Error('Merge requires an existing directory.');
    return {decision:'merge',relativePath};
  }
  if(picked.choice==='replace'&&(!info.is_regular_file||isFolder))throw new Error('Replace is allowed only for regular files.');
  if(picked.choice==='keep-both'){
    if(isFolder)return {decision:'keep-both',relativePath:info.keep_both_path.substring(destination.replace(/\/$/,'').length+1)};
    return {decision:'keep-both',relativePath};
  }
  return {decision:picked.choice,relativePath};
}
async function prepareTransferFolder(destination,relativePath,confirmation){
  const {decision,relativePath:chosen}=await transferConflictChoice(destination,relativePath,true);
  if(decision==='skip')return null;
  if(decision!=='merge'){
    const result=await api('api/file.php',{method:'POST',body:JSON.stringify({action:'mkdir',destination,relative_path:chosen,confirmation_text:confirmation})});
    if(!result.created)throw new Error(`The folder ${chosen} appeared while transferring; retry to choose how to handle it.`);
  }
  return chosen;
}
async function uploadTransferFile(file,destination,relativePath,confirmation=''){
  const choice=await transferConflictChoice(destination,relativePath,false);
  if(choice.decision==='skip')return {skipped:true};
  const start=await api('api/transfer.php?action=start',{method:'POST',body:JSON.stringify({name:file.name,size:file.size,destination,relative_path:choice.relativePath,confirmation_text:confirmation,conflict_action:choice.decision})});
  let offset=0;const chunkSize=start.chunk_bytes||8388608;
  while(offset<file.size){const chunk=file.slice(offset,Math.min(file.size,offset+chunkSize));const response=await fetch('api/transfer.php?action=chunk',{method:'PUT',credentials:'same-origin',headers:{'X-CSRF-Token':csrf,'X-Transfer-Id':start.transfer_id,'X-Chunk-Offset':String(offset)},body:chunk});const data=await response.json().catch(()=>({ok:false,error:`HTTP ${response.status}`}));if(!response.ok||!data.ok)throw new Error(data.error||'Transfer upload failed.');markServerActivity();offset=data.received;$('transferStatus').textContent=`Uploading ${choice.relativePath}: ${formatBytes(offset)} / ${formatBytes(file.size)}`;}
  return api('api/transfer.php?action=finish',{method:'POST',body:JSON.stringify({transfer_id:start.transfer_id})});
}

async function transferWriteConfirmation(destination){const info=await api(`api/file.php?action=transfer-destination-info&path=${encodeURIComponent(destination)}`);return info.critical?criticalConfirmation('TRANSFER','WARNING — Windows files will be written into a critical Linux system/application path.'):'';}
async function copyWindowsHandleToLinux(item,destination,confirmation=''){
  if(!isAdmin())throw new Error('Administrator permission is required to write files to Linux.');
  if(item.kind==='file'){
    const file=await item.handle.getFile(),result=await uploadTransferFile(file,destination,item.name,confirmation);
    return {files:result.skipped?0:1,dirs:0,skipped:result.skipped?1:0,complete:!result.skipped};
  }
  let files=0,dirs=0,skipped=0;
  const walk=async(handle,prefix)=>{
    const chosen=await prepareTransferFolder(destination,prefix,confirmation);
    if(chosen===null){skipped++;return false;}
    dirs++;let complete=true;
    for await(const [name,child] of handle.entries()){
      const rel=`${chosen}/${name}`;
      if(child.kind==='directory'){
        if(!(await walk(child,rel)))complete=false;
      }else{
        const file=await child.getFile();const r=await uploadTransferFile(file,destination,rel,confirmation);
        if(!r.skipped)files++;else{skipped++;complete=false;}
      }
    }
    return complete;
  };
  const complete=await walk(item.handle,item.name);return {files,dirs,skipped,complete};
}

async function copyWindowsItemsToLinux(items,destination){
  resetTransferConflictPolicy();
  if(!items.length)throw new Error('Select one or more Windows files/folders first.');
  $('transferStatus').textContent=`Preparing ${items.length} Windows item(s) → Linux…`;
  const confirmation=await transferWriteConfirmation(destination);let files=0,dirs=0,skipped=0;const itemResults=[];
  try{
    for(const item of items){const result=await copyWindowsHandleToLinux(item,destination,confirmation);files+=result.files;dirs+=result.dirs;skipped+=result.skipped;itemResults.push({item,...result});}
    clearTransferSelection('windows');
    $('transferStatus').textContent=`Windows → Linux complete (${files} files, ${dirs} folders${skipped?`, ${skipped} skipped`:''}).`;
    return {files,dirs,skipped,itemResults};
  }finally{await refreshAfterLinuxMutation({containers:[destination],tree:true});}
}
async function copySelectedWindowsToLinux(){
  return copyWindowsItemsToLinux([...state.transferWindowsSelected.values()],state.transferLinuxPath);
}
async function copyLinuxFileToWindows(path,dir,filename){
  const picked=await chooseWindowsConflict(dir,filename,false);
  if(picked.choice==='skip')return false;
  // Windows File System Access API applies createWritable changes at close;
  // Replace is only entered after the user explicitly chooses it.
  const staged=await stagePathDownload(path);
  await saveStagedJobToHandle(staged,dir,picked.name,picked.choice==='replace');
  return true;
}
async function copyLinuxItemToWindows(item,dir){
  if(!item.is_dir){
    $('transferStatus').textContent=`Copying ${item.name} to Windows…`;
    const copied=await copyLinuxFileToWindows(item.path,dir,item.name);
    return {files:copied?1:0,folders:0,skipped:copied?0:1};
  }
  const picked=await chooseWindowsConflict(dir,item.name,true);
  if(picked.choice==='skip')return {files:0,folders:0,skipped:1};
  const root=await dir.getDirectoryHandle(picked.name,{create:true});
  const walked=await api(`api/file.php?action=walk&path=${encodeURIComponent(item.path)}`);
  if(walked.truncated)throw new Error(`Folder ${item.name} contains too many entries for direct Windows transfer. Create an archive instead.`);
  let files=0,skipped=0;
  // Map source-relative directory names to the actual destination handle. This
  // retains Keep Both renames and never copies into a skipped subtree.
  const handles=new Map([['',root]]);
  for(const e of walked.entries){
    const parts=e.relative.split('/').filter(Boolean);
    const parentPath=parts.slice(0,-1).join('/');
    const parent=handles.get(parentPath);
    if(e.is_symlink||!parent){skipped++;continue;}
    if(e.is_dir){
      const dirChoice=await chooseWindowsConflict(parent,parts[parts.length-1],true);
      if(dirChoice.choice==='skip'){skipped++;continue;}
      const handle=await parent.getDirectoryHandle(dirChoice.name,{create:true});
      handles.set(e.relative,handle);
      continue;
    }
    $('transferStatus').textContent=`Copying ${item.name}/${e.relative}…`;
    if(await copyLinuxFileToWindows(e.path,parent,parts[parts.length-1]))files++;else skipped++;
  }
  return {files,folders:1,skipped};
}

async function browserDownloadLinuxItems(items){
  let jobId;
  if(items.length===1&&!items[0].is_dir){const staged=await stagePathDownload(items[0].path);jobId=staged.job_id;}
  else{
    const filename='linux-transfer-'+new Date().toISOString().slice(0,10);
    const created=await api('api/create.php',{method:'POST',body:JSON.stringify({paths:items.map(x=>x.path),archive_name:filename,format:'zip',windows_requested:true,linux_destination:null})});
    const job=await watchJob(created.job_id);
    if(!['completed','warning'].includes(job.status))throw new Error(job.message||'Unable to prepare selected Linux files.');
    jobId=created.job_id;
  }
  requestBrowserDownload(jobId);
  clearTransferSelection('linux');
  $('transferStatus').textContent=items.length===1&&!items[0].is_dir?'Browser download requested for the selected file.':'Browser download requested as one ZIP.';
}
async function copyLinuxItemsToWindows(items,dir){
  resetTransferConflictPolicy();
  if(!items.length)throw new Error('Select one or more Linux files/folders first.');
  if(!dir||!(await ensureWindowsPermission()))throw new Error('Choose and authorize a Windows destination folder before dragging Linux files to Windows.');
  let files=0,folders=0,skipped=0,fallback=false;const itemResults=[];
  try{
    for(const item of items){
      if(item.protected)throw new Error(`Protected Linux item cannot be transferred: ${item.name}`);
      try{
        const r=await copyLinuxItemToWindows(item,dir);files+=r.files;folders+=r.folders;skipped+=r.skipped;itemResults.push({item,...r,complete:r.skipped===0});
      }catch(err){
        if(err?.browserDownloadFallback&&items.length===1&&!item.is_dir){await browserDownloadLinuxItems(items);fallback=true;itemResults.push({item,files:0,folders:0,skipped:1,complete:false,fallback:true});break;}
        throw err;
      }
    }
    if(!fallback)clearTransferSelection('linux');
  }catch(err){
    await refreshTransferWindows();
    throw err;
  }
  await refreshTransferWindows();
  if(fallback){$('transferStatus').textContent='Direct Windows-folder copy was blocked for this filename, so a normal browser download was requested instead.';return {files,folders,skipped:skipped+1,fallback,itemResults};}
  $('transferStatus').textContent=`Linux → Windows complete (${files} files, ${folders} folders${skipped?`, ${skipped} skipped`:''}).`;
  return {files,folders,skipped,fallback,itemResults};
}

async function copySelectedLinuxToWindows(){
  const items=[...state.transferLinuxSelected.values()];
  if(!items.length)throw new Error('Select one or more Linux files/folders first.');
  // Button-based fallback: when no writable Windows folder is authorized, request a browser download.
  if(!(await ensureTransferWindows(false))){
    $('transferStatus').textContent='Preparing a browser download…';
    await browserDownloadLinuxItems(items);
    return;
  }
  return copyLinuxItemsToWindows(items,transferWindowsCurrent());
}
// WinSCP-style drag-and-drop inside the Transfer dialog. FileSystemHandle objects
// stay only in JS memory; do not serialize paths/handles into drag data or clipboard.
const transferDragMime='application/x-lae-pane-transfer';
function startTransferPaneDrag(ev,side,item){
  if(state.transferDropBusy||(side==='linux'&&item.protected)){ev.preventDefault();return;}
  const map=transferMap(side),key=transferKey(side,item);
  if(!map.has(key)){
    map.clear();map.set(key,item);setTransferAnchor(side,transferEntries(side).indexOf(item));
    renderTransferSelectionState(side);updateTransferSelectionUI();
  }
  const items=[...map.values()];
  if(side==='linux'&&items.some(x=>x.protected)){
    ev.preventDefault();toast('Protected Linux folders cannot be dragged.');return;
  }
  state.transferInternalDrag={side,items};
  ev.dataTransfer.effectAllowed='copy';
  ev.dataTransfer.setData(transferDragMime,side);
  ev.currentTarget.classList.add('transfer-dragging');
}
function clearTransferDropMarkers(){
  document.querySelectorAll('#transferModal .transfer-drop-target,#transferModal .transfer-folder-target,#transferModal .transfer-dragging').forEach(e=>e.classList.remove('transfer-drop-target','transfer-folder-target','transfer-dragging'));
}
function endTransferPaneDrag(){state.transferInternalDrag=null;clearTransferDropMarkers();}
function transferPaneDestination(side,element){
  const row=element.closest('.transferitem');
  const list=$(side==='linux'?'transferLinuxList':'transferWindowsList');
  if(row&&list.contains(row)&&row.dataset.isDir==='1'){
    const item=transferEntries(side).find(e=>transferKey(side,e)===row.dataset.key);
    if(!item)throw new Error('Destination folder changed; refresh and try again.');
    if(side==='linux'){
      if(item.protected||item.browsable===false)throw new Error('The destination is a protected Linux folder.');
      return {linuxPath:item.path,row};
    }
    return {windowsHandle:item.handle,row};
  }
  return side==='linux'?{linuxPath:state.transferLinuxPath,row:null}:{windowsHandle:transferWindowsCurrent(),row:null};
}
function handleTransferPaneDragOver(ev,side){
  const internal=state.transferInternalDrag;
  const isInternal=internal&&internal.side!==side&&ev.dataTransfer?.types.includes(transferDragMime);
  const external=side==='linux'&&!internal&&ev.dataTransfer?.types.includes('Files');
  if(!isInternal&&!external)return;
  ev.preventDefault();ev.stopPropagation();ev.dataTransfer.dropEffect='copy';
  clearTransferDropMarkers();
  let target;
  try{target=transferPaneDestination(side,ev.target);}catch{ev.dataTransfer.dropEffect='none';return;}
  (target.row||$(side==='linux'?'transferLinuxList':'transferWindowsList')).classList.add(target.row?'transfer-folder-target':'transfer-drop-target');
}
async function handleTransferPaneDrop(ev,side){
  const internal=state.transferInternalDrag;
  const isInternal=internal&&internal.side!==side&&ev.dataTransfer?.types.includes(transferDragMime);
  const external=side==='linux'&&!internal&&ev.dataTransfer?.types.includes('Files');
  if(!isInternal&&!external)return;
  ev.preventDefault();ev.stopPropagation();clearTransferDropMarkers();
  if(state.transferDropBusy){toast('A transfer is already running.');return;}
  const target=transferPaneDestination(side,ev.target);
  if(isInternal){
    // Capture the source before any awaited operation; dragend may fire during the copy.
    const items=[...internal.items],from=internal.side;
    state.transferInternalDrag=null;
    state.transferDropBusy=true;
    try{
      if(from==='windows'&&side==='linux')await copyWindowsItemsToLinux(items,target.linuxPath);
      else if(from==='linux'&&side==='windows')await copyLinuxItemsToWindows(items,target.windowsHandle);
    }catch(err){
      if(err instanceof TransferCancelled){$('transferStatus').textContent='Transfer cancelled. No unapproved replacements were made.';}
      else{$('transferStatus').textContent=`Transfer failed: ${err.message}`;toast(err.message,8500);}
    }finally{state.transferDropBusy=false;clearTransferDropMarkers();}
    return;
  }
  // Windows Explorer drops directly on Linux folder rows or blank pane space.
  state.transferDropBusy=true;
  try{await handleTransferDrop(ev,target.linuxPath);}finally{state.transferDropBusy=false;clearTransferDropMarkers();}
}
function bindTransferPaneDrops(side){
  const list=$(side==='linux'?'transferLinuxList':'transferWindowsList');
  const target=side==='linux'?(list.closest('.transferpane')||list):list;
  target.addEventListener('dragover',ev=>handleTransferPaneDragOver(ev,side));
  target.addEventListener('dragleave',ev=>{if(!target.contains(ev.relatedTarget))clearTransferDropMarkers();});
  target.addEventListener('drop',ev=>handleTransferPaneDrop(ev,side).catch(err=>toast(err.message,8500)));
}

async function droppedEntries(dataTransfer){const items=[...dataTransfer.items||[]];const out=[];for(const item of items){const entry=item.webkitGetAsEntry?item.webkitGetAsEntry():null;if(entry)out.push(entry);else{const file=item.getAsFile?.();if(file)out.push(file);}}return out;}
function readEntryFile(entry){return new Promise((resolve,reject)=>entry.file(resolve,reject));}
function readDirectoryEntries(reader){return new Promise((resolve,reject)=>reader.readEntries(resolve,reject));}
async function uploadDroppedEntry(entry,destination,prefix='',confirmation=''){
  if(entry instanceof File){return uploadTransferFile(entry,destination,prefix+entry.name,confirmation);}
  if(entry.isFile){const file=await readEntryFile(entry);return uploadTransferFile(file,destination,prefix+file.name,confirmation);}
  if(entry.isDirectory){
    const base=await prepareTransferFolder(destination,prefix+entry.name,confirmation);
    if(base===null)return {skipped:true};
    const reader=entry.createReader();
    while(true){const children=await readDirectoryEntries(reader);if(!children.length)break;
      for(const child of children)await uploadDroppedEntry(child,destination,base+'/',confirmation);
    }
  }
}

async function uploadClipboardFiles(files){resetTransferConflictPolicy();if(!isAdmin())throw new Error('Administrator permission is required to upload files to Linux.');const list=[...files];if(!list.length)throw new Error('The browser did not expose copied Windows files. Use drag-and-drop for folders or if Paste is unavailable.');const destination=state.transferLinuxPath,confirmation=await transferWriteConfirmation(destination);try{for(const file of list)await uploadTransferFile(file,destination,file.name,confirmation);$('transferStatus').textContent=`Pasted ${list.length} Windows file${list.length===1?'':'s'} into ${destination}.`;}finally{await refreshAfterLinuxMutation({containers:[destination]});}}
async function handleTransferPasteEvent(ev){
  const files=[...(ev.clipboardData?.files||[])];
  ev.preventDefault();ev.stopPropagation();
  if(!files.length){$('transferStatus').textContent='The browser did not expose copied Windows files. Try Ctrl+V again or drag-and-drop; folders are most reliable with drag-and-drop.';toast('The browser did not expose copied Windows files. Use drag-and-drop if Paste is unavailable.',7000);return;}
  try{await uploadClipboardFiles(files);}catch(err){if(!(err instanceof TransferCancelled))toast(err.message,7000);}
}
async function handleTransferDrop(ev,destination=state.transferLinuxPath){resetTransferConflictPolicy();ev.preventDefault();$('transferLinuxDrop').classList.remove('dragover');if(!isAdmin()){toast('Administrator permission is required to upload files to Linux.');return;}let entries=[];try{entries=await droppedEntries(ev.dataTransfer);if(!entries.length)throw new Error('No files or folders were found in the drop.');const confirmation=await transferWriteConfirmation(destination);for(const entry of entries)await uploadDroppedEntry(entry,destination,'',confirmation);$('transferStatus').textContent='Windows drag-and-drop upload complete.';}catch(err){if(!(err instanceof TransferCancelled))toast(err.message,7000);}finally{if(entries.length)await refreshAfterLinuxMutation({containers:[destination],tree:true});}}
async function handleExplorerDrop(ev,destination=state.currentPath){
  ev.preventDefault();ev.stopPropagation();document.querySelector('.filetable-wrap').classList.remove('dragover');document.querySelectorAll('.filetable tr.drop-target').forEach(x=>x.classList.remove('drop-target'));
  if(!isAdmin())throw new Error('Administrator permission is required to upload files to Linux.');const entries=await droppedEntries(ev.dataTransfer);if(!entries.length)throw new Error('No files or folders were found in the drop.');const confirmation=await transferWriteConfirmation(destination);showModal('progressModal');$('progressModalTitle').textContent='Windows → Linux';$('progressTitle').textContent='Uploading files…';$('progressMessage').textContent=`Saving dropped item(s) into ${destination}`;$('stageFill').style.width='45%';$('stageCaption').textContent='Uploading';
  try{for(const entry of entries)await uploadDroppedEntry(entry,destination,'',confirmation);$('stageFill').style.width='100%';$('stageCaption').textContent='Complete';hideModal('progressModal');toast(`Windows drag-and-drop upload completed to ${destination}.`);}catch(err){hideModal('progressModal');throw err;}finally{await refreshAfterLinuxMutation({containers:[destination],tree:true});}
}

const helpSections={
  start:{title:'Getting Started',html:'<h2>Getting Started</h2><p>Back, Forward, Up, + Folder, + File, Copy Selected, Cut Selected, the Linux directory path and Search are all in one compact toolbar row, in that order. Protected virtual folders such as /dev, /proc, /sys and /run appear greyed out in both the tree and file list; they cannot be browsed or selected. Hover to see the reason. The subtle green oval beside the title shows the machine hostname.</p><p>Browse Linux like File Explorer. Select files or folders, name the archive, choose Windows, Linux, or Both, then select <b>Create Archive</b>. After a successful archive, the selection clears automatically so the next job starts clean.</p><p>For a new item, click <b>+ Folder</b> or <b>+ File</b> in the toolbar; these work even when the file list has no empty area. The right-click background menu has the same choices. Checkboxes select items for <b>Create Archive</b> or <b>Copy Selected</b>/<b>Cut Selected</b>; nothing is archived or moved by merely checking a box.</p><p>Right-click files, folders and archives for Explorer-style actions such as Open, Copy, Rename, Properties, View Archive, Verify, Restore and Delete where your account role allows them.</p>'},
  fileops:{title:'Copy, Cut and Paste',html:'<h2>Copy, Cut and Paste on Linux</h2><p><b>Copy</b> and <b>Cut</b> work between Linux folders inside Linux Archive Explorer. They do not put files onto the Windows clipboard.</p><ol><li>Right-click a Linux item and choose <b>Copy</b> or <b>Cut</b>. For multiple files, check the boxes and click <b>Copy Selected</b> or <b>Cut Selected</b>.</li><li>Navigate to the destination Linux folder.</li><li>Choose <b>Paste Here</b> from the right-click menu, even when you right-click another file. For a particular folder, use <b>Paste Into Folder</b>.</li></ol><p>To create new items, use the visible <b>+ Folder</b>/<b>+ File</b> toolbar controls or the background right-click menu. New File creates an empty file and never overwrites an existing name.</p><p>When a name already exists, a centered dialog offers <b>Replace</b> (files), <b>Keep Both</b>, <b>Skip</b>, or <b>Cancel</b>; copying folders may also offer <b>Merge Folder</b>. Use <b>Apply to remaining</b> only if appropriate for the current batch. Replacing a Linux file saves an eligible protected safety copy.</p><p><b>Cut does not immediately remove the original.</b> The original stays until Paste succeeds. If you cancel, unprocessed items remain. Critical destinations (including /) require typing COPY or MOVE.</p><p>For Windows, use <b>Download / Save to Windows</b> or the separate <b>Transfer</b> window.</p>'},
  search:{title:'Finding Files',html:'<h2>Finding Files</h2><p>Type a name in Search to filter the open Linux folder. To search folders below it, check <b>Subfolders</b> and enter at least two characters. Results show each full containing folder; select <b>Open location</b> to jump to that file or folder. Searches match names, not file contents. Protected application workspaces, virtual filesystems, and other mounted filesystems are not traversed. Large searches stop at safety limits; narrow the search or open a lower folder to continue.</p>'},
  selecting:{title:'Selecting Files',html:'<h2>Selecting Files and Folders</h2><p>Single-click a selectable row to select it, Ctrl/Command-click to toggle individual items, Shift-click to select a visible range, or use the checkboxes and Select All. Double-click an ordinary folder to open it. Clicking empty file-list space clears the current selection. Selections stay active while you move through different Linux folders until an archive succeeds or you clear them. Selecting a parent folder makes separate child selections unnecessary. Runtime filesystems such as /proc, /sys, /dev and /run are protected from ordinary archive selection.</p>'},
  transfer:{title:'Windows ↔ Linux Transfer',html:'<h2>Windows ↔ Linux Transfer</h2><p><b>Direct Windows folder browsing and Windows-side file management require a secure browser context (normally trusted HTTPS).</b> Plain LAN HTTP can still use Windows → Linux drag/drop/paste and Linux → Windows browser downloads, but those fallbacks do not provide full Windows-pane management.</p><p>Select <b>Transfer ⇄</b> for a two-pane Linux/Windows transfer view. <b>Double-click a folder</b> (or select it and press Enter) to open it. Drag files and folders directly between panes to copy them; drop onto a folder to copy inside it, or onto the pane for the open folder. For Windows-side writes, first click <b>Choose Folder</b> and grant browser permission. You can also drag files/folders from Windows Explorer anywhere onto the Linux pane or press Ctrl+V. Dropping a Windows file elsewhere in the Transfer dialog is rejected instead of allowing the browser to open the local file.</p><p><b>Right-click inside either Transfer pane</b> for Copy, Cut, Paste, Rename and Delete; Linux also offers Properties. Transfer uses its <b>own clipboard</b>, separate from the main Explorer. Copy/Cut can be pasted Linux→Linux, Linux→Windows, Windows→Linux or Windows→Windows, and cross-pane Paste labels identify the source. Closing Transfer clears this temporary clipboard.</p><p><b>Cut is copy-first.</b> A source is removed only after that entire source item has copied successfully. If any child is skipped, cancelled, blocked or incomplete, that source item remains. Linux actions retain the normal protected recovery and critical-path safeguards. Windows actions stay inside the browser-authorized folder tree.</p><p>When a destination name exists, a centered dialog offers <b>Replace</b>, <b>Keep Both</b>, <b>Skip</b>, or <b>Cancel</b>. Existing folders can offer <b>Merge Folder</b>. The optional <b>Apply to remaining</b> checkbox applies only to that transfer. Files are never silently overwritten.</p><p>Browser security shows only the authorized Windows folder name and relative subfolders, not a full drive-letter path. At the root of that folder, the Windows Up button opens Choose Folder so you can authorize a higher folder; a website cannot navigate outside the selected boundary on its own.</p>'},
  editor:{title:'Viewing / Editing Text Files',html:'<h2>Viewing / Editing Text Files</h2><p>Administrators can browse normal Linux directories and Linux Archive Explorer working directories, then double-click a regular non-archive file or right-click it and choose <b>Open / Edit Text…</b>. This includes ordinary configuration files such as <code>config.ini</code>. The backend verifies UTF-8 text before opening the editor; binary, symlink, oversized and unsupported multi-hard-link targets are refused.</p><p>Before Save, Linux Archive Explorer checks that the file has not changed, creates a protected safety copy under <code>/var/www/linux-archive-explorer/rollback/edits/</code>, preserves file metadata and replaces the file atomically. The safety copy is accessible only by the Linux root account and is not stored in <code>/root</code>. The live <code>config.ini</code> and critical operating-system paths require typing <code>SAVE</code>; ordinary Linux Archive Explorer source/documentation files do not. All saves still receive a protected pre-edit backup. Virtual filesystems such as <code>/proc</code>, <code>/sys</code>, <code>/dev</code> and <code>/run</code> are browse-only and cannot be edited. The editor includes line numbers, search, Review Changes and Review Last Save.</p>'},
  windows:{title:'Saving to Windows',html:'<h2>Saving to Windows</h2><p>For Create Archive, select <b>Windows computer</b> or <b>Both</b>. After creation, click <b>Download to Windows</b> once. Your browser downloads the verified archive and may ask where to save it.</p><p>The separate Transfer window can browse a Windows folder only while Chrome grants permission. If permission expires or Chrome blocks a protected folder, choose another Windows folder or use browser downloads and Windows Explorer Ctrl+V / drag-and-drop. The browser controls where downloads are saved.</p><p><b>Choose your download folder:</b> In Google Chrome, open <b>Settings → Downloads</b> and enable <b>Ask where to save each file before downloading</b>. Chrome will then let you choose the destination folder for each archive download.</p>'},
  linux:{title:'Saving on Linux',html:'<h2>Saving on Linux</h2><p>Choose a suitable Linux destination. The archive is created in protected staging, verified, SHA-256 hashed internally, then copied atomically to the selected destination. Existing archive names are never silently overwritten.</p><p>Linux Archive Explorer does not create a .sha256 sidecar by default. Use <b>Verify Archive</b> or <b>Copy SHA-256</b> when you need integrity information.</p>'},
  formats:{title:'Archive Formats',html:'<h2>Archive Formats</h2><p><b>.tar.gz</b> is recommended for general Linux backup. <b>.tar.zst</b> is fast, <b>.tar.xz</b> favors smaller archives, and <b>.tar</b> is uncompressed. Tar formats are the best choice when Linux ownership, ACLs, extended attributes, symlinks and sparse-file fidelity matter.</p><p><b>.zip</b> is included for Windows portability and convenience. ZIP restore is supported, but ZIP cannot preserve all Linux metadata with the same fidelity as the tar formats, so it is not the preferred format for system backups.</p>'},
  archives:{title:'Viewing / Managing Archives',html:'<h2>Viewing and Managing Archives</h2><p>Right-click a supported tar or ZIP archive to open/view its contents, verify it, copy its SHA-256, save it to Windows, restore it, view properties, or delete it if your role permits. Delete moves protected items through the application safety path rather than silently overwriting or removing unrelated data.</p>'},
  restore:{title:'Restoring',html:'<h2>Restoring</h2><p><b>From Windows</b> opens the browser file picker so you can choose an existing Linux Archive Explorer archive saved on this Windows PC, an attached drive, Desktop, Downloads, or another Windows-accessible folder. Supported restore archives are <code>.tar</code>, <code>.tar.gz</code>, <code>.tar.xz</code>, <code>.tar.zst</code> and <code>.zip</code>. <b>From Linux</b> selects an archive already stored on the Linux machine.</p><p>Every Restore entry point uses the same protected workflow: inspect and verify the archive, preview the original paths, create a safety rollback package, display the restore warning, require deliberate confirmation, restore, then verify the result.</p><p><b>Inspect Archive</b> verifies and previews. After it passes, choose <b>Inspect Again</b> to refresh the preview or <b>Continue to Restore</b> for the safety warning. A failed check shows <b>Retry Inspection</b>. Archives identify the original Linux hostname. When an archive comes from another Linux system, Restore clearly warns about the source and destination and requires typing RESTORE. <b>Restore is never one click.</b> This is true whether Restore starts from the top button, the archive viewer, or the right-click menu. Critical system restores require typing <b>RESTORE</b>. Open <b>Restore History</b> to verify, protect, roll back, or delete a retained safety backup later. Successful unprotected backups have bounded automatic retention; critical or failed-recovery backups are protected.</p>'},
  users:{title:'Users and Roles',html:'<h2>Users and Roles</h2><p>An Administrator has broad filesystem-management access through Linux Archive Explorer, including browsing normal system/application directories, editing regular text/configuration files, creating folders/files, copy/move, rename, Delete, Restore, Settings and user management. Critical operations retain confirmations and recovery safeguards. Virtual filesystems remain browse-only.</p><p>A standard User is intentionally non-mutating: Users can browse, select/create archives, view and verify archives, and download files, but cannot edit, create, rename, move, delete, Restore, or change application/system settings. The installer creates the first Administrator. The current account and last enabled Administrator are protected from unsafe deletion/demotion.</p>'},
  settings:{title:'Settings / Sessions',html:'<h2>Settings and Sessions</h2><p>The Light/Dark theme toggle is always available in the top bar and persists in the browser. Settings contains account and administrative preferences such as session timeout and default archive format.</p><p>Administrators can use <b>Cleanup &amp; Storage</b> to inspect disk use or type RESET to remove eligible temporary and unprotected recovery files. Permanent archives, accounts, configuration and protected recovery are preserved. Automatic cleanup remains active without user action.</p><p>The server enforces the session timeout and the browser also returns to login when the visible session becomes idle, so a sleeping computer does not leave a stale authenticated-looking Explorer screen indefinitely.</p>'},
  cloud:{title:'Cloud / VPS',html:'<h2>Cloud and VPS Use</h2><p>Linux Archive Explorer can run on a supported Linux VPS or cloud VM. Public installations should use HTTPS. If HTTPS terminates at a reverse proxy, configure only that trusted proxy in the installer so forwarded HTTPS headers are not trusted from arbitrary clients.</p>'},
  security:{title:'Security',html:'<h2>Security</h2><p>The web server does not get unrestricted sudo. It can execute only root-owned Linux Archive Explorer helpers through narrow sudoers rules. Helpers validate operations and paths again. Configuration, user credentials and privileged code remain outside the public web directory and are not writable by the web user.</p><p>Operations involving critical Linux paths require stronger confirmations. Restore always has its own mandatory warning and confirmation workflow.</p>'},
  logs:{title:'Logging',html:'<h2>Logging</h2><p>Linux Archive Explorer suppresses only successful high-frequency LAE job-status/SSE and upload/transfer chunk requests from Apache access.log; errors remain logged. If the existing Apache access-log policy already honors the shared suppression flag, LAE uses it unchanged. A conventional simple Debian access-log directive may receive a narrow reversible condition; customized logging that cannot be changed safely causes setup to stop rather than guess. Clean installations use LAE-owned HTTP/HTTPS virtual hosts with the compatible filtered CustomLog, and any enabled stock access.log directive that could still receive LAE requests gets the same narrow reversible condition.</p><p>Uninstall removes only LAE logging integration and preserves unrelated Apache changes. LAE also avoids idle one-second polling and uses Server-Sent Events only while a job is active, with a temporary 3-second status fallback if needed. Its own audit and error logs rotate daily, are capped at 5 MiB, keep two old copies and are not compressed.</p>'},
  installer:{title:'Installer / Repair',html:'<h2>Installer, Update, Verify and Repair</h2><p>The installer handles first installation, updates, Repair, Verify, Administrator password recovery and destructive Uninstall. Normal setup performs install/update directly with concise progress output; detailed technical checks are shown only with --verify. All operations use an exclusive lock; installation, repair and uninstall refuse while Restore, archive/file operations or recent transfers are active.</p><p>The application uses one directory: /var/www/linux-archive-explorer. Its Git checkout, runtime code and protected data are contained under this tree. Updates verify a protected rollback and preserve account settings, archives and recovery data. Settings &gt; Cleanup &amp; Storage shows disk use and confirms eligible temporary cleanup. Verify checks ownership, permissions, sudoers, Apache/PHP execution, logging, helper access and application health.</p><p><b>--uninstall</b> is the single complete uninstall command. After typing UNINSTALL it permanently removes Linux Archive Explorer code, configuration, accounts, saved archives, logs and recovery data. When a valid first-install ledger exists, it also reverses only packages proven to have been introduced by Linux Archive Explorer and refuses unsafe APT removal; pre-existing/shared packages and unrelated Apache configuration are preserved. Back up important archives outside the app tree first.</p>'},
  update:{title:'Updates',html:'<h2>Version and Updates</h2><p>The green oval beside the product subtitle shows the Linux machine hostname, also used for suggested archive filenames. Hover over the folder icon at the upper left to see the installed version. When the official repository publishes a newer version, the folder gently brightens and dims; hovering shows the newer version. Click the folder icon to open the GitHub repository.</p><p>Updates are never installed automatically. Download the tested release and use the installer, which creates a protected rollback before updating.</p>'},
  troubleshooting:{title:'Troubleshooting',html:'<h2>Troubleshooting</h2><p>Open Settings → System Information to copy safe diagnostic information. From the Linux command line, installer Verify mode checks ownership, permissions, sudoers, Apache integration, PHP syntax, helper access and application health without exposing passwords or session secrets.</p>'},
};function buildHelp(){const nav=$('helpNav');nav.innerHTML='';for(const [key,item] of Object.entries(helpSections)){const b=document.createElement('button');b.textContent=item.title;b.dataset.tip=`Open ${item.title} help`;b.onclick=()=>showHelpSection(key);nav.appendChild(b);}showHelpSection('start');}
function showHelpSection(key){const item=helpSections[key]||helpSections.start;$('helpContent').innerHTML=item.html;document.querySelectorAll('#helpNav button').forEach(b=>b.classList.toggle('active',b.textContent===item.title));}

async function loadSystemInfo(){
  try{const data=await api('api/system.php');const s=data.system;const rows=[['Hostname',s.hostname],['Operating system',s.os],['Architecture',s.architecture],['Linux Archive Explorer',`v${s.version}`],['PHP',s.php],['GNU tar',s.tar],['Archive storage',s.archive_storage],['Free storage',formatBytes(s.free_bytes)],['Deployment',s.deployment],['HTTPS',s.https?'Yes':'No']];$('systemInfo').innerHTML=rows.map(([k,v])=>`<div><b>${escapeHtml(k)}</b><span>${escapeHtml(v??'')}</span></div>`).join('');$('systemInfo').dataset.copy=rows.map(([k,v])=>`${k}: ${v??''}`).join('\n');}catch(err){$('systemInfo').textContent=err.message;}
}

function initTooltips(){
  const tip=$('tooltip');function show(el){if(!$('contextMenu').classList.contains('hidden')&&!el.closest('#contextMenu'))return;const text=el.getAttribute('data-tip');if(!text)return;clearTimeout(tooltipTimer);tooltipTimer=setTimeout(()=>{if(el.closest('.modalbackdrop.hidden'))return;tip.textContent=text;tip.classList.remove('hidden');const r=el.getBoundingClientRect(),tr=tip.getBoundingClientRect();let left=Math.min(window.innerWidth-tr.width-8,Math.max(8,r.left+r.width/2-tr.width/2));let top=r.bottom+8;if(top+tr.height>window.innerHeight-8)top=r.top-tr.height-8;tip.style.left=`${left}px`;tip.style.top=`${Math.max(8,top)}px`;},260);}function hide(){dismissTooltip();}
  document.addEventListener('mouseover',e=>{const el=e.target.closest('[data-tip]');if(el)show(el);});document.addEventListener('mouseout',e=>{if(e.target.closest('[data-tip]'))hide();});document.addEventListener('focusin',e=>{const el=e.target.closest('[data-tip]');if(el)show(el);});document.addEventListener('focusout',hide);document.addEventListener('touchstart',e=>{const el=e.target.closest('[data-tip]');if(el&&e.touches.length===1){hide();}}, {passive:true});
}

$('backBtn').onclick=()=>{if(state.historyIndex>0){state.historyIndex--;navigate(state.history[state.historyIndex],false);}};
$('forwardBtn').onclick=()=>{if(state.historyIndex<state.history.length-1){state.historyIndex++;navigate(state.history[state.historyIndex],false);}};
$('upBtn').onclick=()=>navigate(parentPath(state.currentPath));
$('searchInput').addEventListener('input',queueSearch);
$('searchSubfolders').addEventListener('change',queueSearch);
$('selectAll').addEventListener('change',()=>{const add=$('selectAll').checked;for(const e of sortedEntries()){if(!e.selectable)continue;const p=pathJoin(state.currentPath,e.name);if(add){if(![...state.selected.keys()].some(existing=>existing===p||isDescendant(p,existing)))state.selected.set(p,{path:p,name:e.name,is_dir:e.is_dir,size:e.size});}else state.selected.delete(p);}renderFiles();updateSelectionUI();maybeSuggestName();});
document.querySelectorAll('.filetable th[data-sort]').forEach(th=>th.addEventListener('click',()=>{const key=th.dataset.sort;if(state.sort.key===key)state.sort.direction=state.sort.direction==='asc'?'desc':'asc';else state.sort={key,direction:'asc'};document.querySelectorAll('.sortmark').forEach(x=>x.textContent='');$(`sort-${key}`).textContent=state.sort.direction==='asc'?'▲':'▼';renderFiles();}));
$('selectionBar').onclick=renderSelectionModal;
$('clearSelection').onclick=()=>{state.selected.clear();renderFiles();updateSelectionUI();renderSelectionModal();maybeSuggestName();};
$('archiveName').addEventListener('input',()=>{$('archiveName').dataset.edited='1';});
$('archiveFormat').addEventListener('change',()=>{$('archiveFormat').dataset.userChanged='1';});
document.querySelectorAll('input[name=destination]').forEach(r=>r.addEventListener('change',updateDestinationUI));

$('chooseLinux').onclick=()=>openLinuxPicker($('linuxPath').value,'archive-destination');
$('folderPickerUp').onclick=()=>{state.folderPickerPath=parentPath(state.folderPickerPath);renderLinuxPicker();};
$('useLinuxFolder').onclick=()=>{if(state.folderPickerPurpose==='restore-source'){$('restoreLinuxPath').value=state.folderPickerPath;hideModal('folderModal');loadRestoreArchiveList(state.folderPickerPath);}else{$('linuxPath').value=state.folderPickerPath;hideModal('folderModal');}};
$('createBtn').onclick=createArchive;
$('downloadBtn').onclick=()=>{if(!state.lastJob||!state.lastJob.windows_requested)return;const job=state.lastJob;$('downloadBtn').disabled=true;requestBrowserDownload(job.id);$('resultWindows').textContent='Download requested — save it when your browser prompts. Open Archive still shows the creation-time verified contents; temporary staging is removed after streaming.';};
$('openArchiveBtn').onclick=openArchiveContents;

if($('restoreHeaderBtn'))$('restoreHeaderBtn').onclick=openRestore;
document.querySelectorAll('[data-close=restoreModal]').forEach(b=>b.addEventListener('click',()=>discardRestoreUpload()));
document.querySelectorAll('.source-tab').forEach(b=>b.onclick=()=>setRestoreSource(b.dataset.source));
$('restoreFile').addEventListener('change',()=>{discardRestoreUpload();clearRestoreInspection();$('uploadProgress').classList.add('hidden');$('uploadFill').style.width='0%';$('uploadText').textContent='';const f=$('restoreFile').files[0];$('restoreFileName').textContent=f?`${f.name} — ${formatBytes(f.size)}`:'No file selected';$('inspectRestoreBtn').disabled=!f;});
$('chooseRestoreLinux').onclick=()=>openLinuxPicker($('restoreLinuxPath').value,'restore-source');
$('inspectRestoreBtn').onclick=inspectRestore;$('continueRestoreBtn').onclick=openRestoreConfirmation;$('restoreAcknowledge').onchange=updateRestoreConfirm;$('restoreConfirmText').oninput=updateRestoreConfirm;$('confirmRestoreBtn').onclick=queueRestore;
$('restoreHistoryBtn').onclick=()=>openRestoreHistory().catch(err=>toast(err.message,7000));
$('refreshRestoreHistory').onclick=async()=>{const ok=await refreshRestoreHistory();if(ok)toast('Restore History is up to date.');};
$('restoreHistoryDeleteText').oninput=()=>{$('confirmHistoryDeleteBtn').disabled=$('restoreHistoryDeleteText').value!=='DELETE';};
$('confirmHistoryDeleteBtn').onclick=confirmRestoreHistoryDelete;
$('rollbackRestoreBtn').onclick=()=>{state.historyRollbackId=null;$('rollbackConfirmText').value='';$('confirmRollbackBtn').disabled=true;showModal('rollbackConfirmModal');};$('rollbackConfirmText').oninput=()=>{$('confirmRollbackBtn').disabled=$('rollbackConfirmText').value!=='ROLLBACK';};$('confirmRollbackBtn').onclick=queueRollback;

$('themeToggle').onclick=toggleTheme;
$('transferBtn').onclick=()=>openTransfer().catch(err=>toast(err.message,7000));
$('helpBtn').onclick=()=>showModal('helpModal');
$('settingsBtn').onclick=async()=>{showModal('settingsModal');await Promise.all([loadSystemInfo(),loadSettings(),isAdmin()?loadUsers():Promise.resolve(),isAdmin()?loadStorage():Promise.resolve()]);};
if($('storageReviewBtn'))$('storageReviewBtn').onclick=()=>loadStorage().catch(err=>toast(err.message,6000));
if($('storageResetBtn'))$('storageResetBtn').onclick=()=>resetStorage().catch(err=>toast(err.message,7000));
$('changePasswordBtn').onclick=async()=>{const current=$('currentPassword').value,newp=$('newPassword').value,confirm=$('confirmPassword').value;try{const data=await api('api/account.php',{method:'POST',body:JSON.stringify({current_password:current,new_password:newp,confirm_password:confirm})});$('currentPassword').value=$('newPassword').value=$('confirmPassword').value='';toast(data.message||'Password changed.');}catch(err){toast(err.message,6000);}};
$('copySystemInfo').onclick=async()=>{try{await navigator.clipboard.writeText($('systemInfo').dataset.copy||$('systemInfo').innerText);toast('System information copied.');}catch{toast('Unable to copy automatically.');}};
if($('saveSettingsBtn'))$('saveSettingsBtn').onclick=()=>saveSettings().catch(err=>toast(err.message,6000));
if($('addUserBtn'))$('addUserBtn').onclick=()=>openUserEditor();
$('saveUserBtn').onclick=()=>saveUser().catch(err=>toast(err.message,6000));
if($('resetUserPasswordBtn'))$('resetUserPasswordBtn').onclick=()=>resetUserPassword().catch(err=>toast(err.message,6000));
$('confirmRenameBtn').onclick=()=>confirmRename().catch(err=>toast(err.message,6000));
$('deleteConfirmText').addEventListener('input',()=>{$('confirmDeleteBtn').disabled=state.deleteCritical&&$('deleteConfirmText').value!=='DELETE';});
$('confirmDeleteBtn').onclick=()=>confirmDelete().catch(err=>toast(err.message,6500));



$('editorText').addEventListener('input',updateEditorLines);$('editorText').addEventListener('scroll',syncEditorScroll);$('editorFindNext').onclick=findEditorNext;$('editorSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();findEditorNext();}});$('editorReviewBtn').onclick=reviewEditorChanges;$('reviewPrev').onclick=()=>goToReviewChange(-1);$('reviewNext').onclick=()=>goToReviewChange(1);$('editorOriginalReview').addEventListener('scroll',()=>synchronizeReviewPanes($('editorOriginalReview'),$('editorCurrentReview')));$('editorCurrentReview').addEventListener('scroll',()=>synchronizeReviewPanes($('editorCurrentReview'),$('editorOriginalReview')));$('editorCancelBtn').onclick=closeTextEditor;$('editorCloseBtn').onclick=closeTextEditor;$('editorSaveBtn').onclick=()=>saveTextEditor().catch(err=>{toast(err.message,7000);$('editorStatus').textContent=err.message;});

$('archiveVerifyBtn').onclick=()=>state.archiveContextPath&&verifyArchivePath(state.archiveContextPath).catch(err=>toast(err.message,6500));
$('archiveDownloadBtn').onclick=()=>{if(state.archiveContextPath)downloadPathToWindows(state.archiveContextPath).catch(err=>toast(err.message,6500));else if(state.lastJob)$('downloadBtn').click();};
if($('archiveRestoreBtn'))$('archiveRestoreBtn').onclick=()=>state.archiveContextPath&&openRestoreForPath(state.archiveContextPath).catch(err=>toast(err.message,6500));
if($('archiveDeleteBtn'))$('archiveDeleteBtn').onclick=()=>state.archiveContextPath&&openDelete(state.archiveContextPath,baseName(state.archiveContextPath)).catch(err=>toast(err.message,6500));

document.querySelector('.filetable-wrap').addEventListener('contextmenu',ev=>{if(ev.target.closest('tr'))return;ev.preventDefault();showBackgroundContextMenu(ev.clientX,ev.clientY);});
document.querySelector('.filetable-wrap').addEventListener('click',ev=>{if(ev.target.closest('tr,thead,input,button,a'))return;if(state.selected.size){state.selected.clear();state.selectionAnchor=null;renderFiles();updateSelectionUI();maybeSuggestName();}});
document.querySelector('.filetable-wrap').addEventListener('dragover',ev=>{if(isAdmin()&&ev.dataTransfer&&ev.dataTransfer.types.includes('Files')){ev.preventDefault();document.querySelector('.filetable-wrap').classList.add('dragover');}});
document.querySelector('.filetable-wrap').addEventListener('dragleave',ev=>{if(!ev.currentTarget.contains(ev.relatedTarget))ev.currentTarget.classList.remove('dragover');});
document.querySelector('.filetable-wrap').addEventListener('drop',ev=>{const row=ev.target.closest('tr');if(row&&row.classList.contains('drop-target'))return;handleExplorerDrop(ev,state.currentPath).catch(err=>toast(err.message,7000));});
document.addEventListener('dragover',ev=>{if(ev.dataTransfer?.types?.includes('Files'))ev.preventDefault();});
document.addEventListener('drop',ev=>{if(ev.dataTransfer?.types?.includes('Files'))ev.preventDefault();});
document.addEventListener('pointerdown',ev=>{if(!ev.target.closest('#contextMenu'))hideContextMenu();});
window.addEventListener('blur',hideContextMenu);
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'){if(pendingConflictResolver){resolveConflictDialog('cancel');ev.preventDefault();return;}if(!$('contextMenu').classList.contains('hidden')){hideContextMenu();ev.preventDefault();return;}const visible=[...document.querySelectorAll('.modalbackdrop:not(.hidden)')].sort((a,b)=>(parseInt(getComputedStyle(a).zIndex)||0)-(parseInt(getComputedStyle(b).zIndex)||0));const top=visible.at(-1);if(top&&top.id!=='progressModal'){if(top.id==='editorModal'){closeTextEditor();}else hideModal(top.id);ev.preventDefault();}}});

if($('newFolderBtn'))$('newFolderBtn').onclick=()=>createNewFolder(state.currentPath).catch(err=>toast(err.message,7000));
if($('newFileBtn'))$('newFileBtn').onclick=()=>createNewFile(state.currentPath).catch(err=>toast(err.message,7000));
if($('copySelectedBtn'))$('copySelectedBtn').onclick=()=>setSelectedClipboard('copy');
if($('cutSelectedBtn'))$('cutSelectedBtn').onclick=()=>setSelectedClipboard('move');
$('conflictReplaceBtn').onclick=()=>resolveConflictDialog('replace');
$('conflictMergeBtn').onclick=()=>resolveConflictDialog('merge');
$('conflictKeepBothBtn').onclick=()=>resolveConflictDialog('keep-both');
$('conflictSkipBtn').onclick=()=>resolveConflictDialog('skip');
$('conflictCancelBtn').onclick=()=>resolveConflictDialog('cancel');
$('conflictCloseBtn').onclick=()=>resolveConflictDialog('cancel');
$('transferUseCurrentLinux').onclick=()=>{state.transferLinuxPath=state.currentPath;state.transferLinuxSelected.clear();state.transferLinuxAnchor=null;refreshTransferLinux();};
$('transferLinuxUp').onclick=()=>{state.transferLinuxPath=parentPath(state.transferLinuxPath);state.transferLinuxSelected.clear();state.transferLinuxAnchor=null;refreshTransferLinux();};
$('transferChooseWindows').onclick=async()=>{const h=await chooseWindowsFolder();if(h){state.transferWindowsRoot=null;await ensureTransferWindows(false);}};
$('transferWindowsUp').onclick=async()=>{if(state.transferWindowsStack.length>1){state.transferWindowsStack.pop();state.transferWindowsSelected.clear();state.transferWindowsAnchor=null;await refreshTransferWindows();}else{const h=await chooseWindowsFolder();if(h){state.transferWindowsRoot=null;await ensureTransferWindows(false);}else $('transferStatus').textContent='Windows folder access stops at the authorized folder. Choose Folder to select a parent or another location.';}};
$('transferToLinux').onclick=()=>copySelectedWindowsToLinux().catch(err=>{if(!(err instanceof TransferCancelled))toast(err.message,7000);});
$('transferToWindows').onclick=()=>copySelectedLinuxToWindows().catch(err=>{if(!(err instanceof TransferCancelled))toast(err.message,7000);});
bindTransferPaneDrops('linux');bindTransferPaneDrops('windows');
const transferLinuxPane=$('transferLinuxList')?.closest('.transferpane');
const transferModal=$('transferModal');
if(transferModal&&transferLinuxPane){
  transferModal.addEventListener('dragover',ev=>{
    if(state.transferInternalDrag||!ev.dataTransfer?.types.includes('Files'))return;
    ev.preventDefault();
    if(!transferLinuxPane.contains(ev.target))ev.dataTransfer.dropEffect='none';
  });
  transferModal.addEventListener('drop',ev=>{
    if(state.transferInternalDrag||!ev.dataTransfer?.types.includes('Files'))return;
    ev.preventDefault();
    if(transferLinuxPane.contains(ev.target))return;
    ev.stopPropagation();clearTransferDropMarkers();$('transferLinuxDrop')?.classList.remove('dragover');
    toast('Drop Windows files anywhere in the Linux pane.',4500);
  });
}
$('transferLinuxDrop').addEventListener('paste',handleTransferPasteEvent);
$('transferLinuxDrop').addEventListener('beforeinput',ev=>ev.preventDefault());
$('transferModal').addEventListener('paste',handleTransferPasteEvent);
if($('transferLinuxSelectAll'))$('transferLinuxSelectAll').onchange=()=>selectAllTransfer('linux',$('transferLinuxSelectAll').checked);
if($('transferWindowsSelectAll'))$('transferWindowsSelectAll').onchange=()=>selectAllTransfer('windows',$('transferWindowsSelectAll').checked);
$('transferLinuxList').addEventListener('click',ev=>{if(!ev.target.closest('.transferitem'))clearTransferSelection('linux');});
$('transferWindowsList').addEventListener('click',ev=>{if(!ev.target.closest('.transferitem'))clearTransferSelection('windows');});
$('transferLinuxList').addEventListener('contextmenu',ev=>{if(ev.target.closest('.transferitem'))return;ev.preventDefault();showTransferBackgroundContextMenu(ev.clientX,ev.clientY,'linux');});
$('transferWindowsList').addEventListener('contextmenu',ev=>{if(ev.target.closest('.transferitem'))return;ev.preventDefault();showTransferBackgroundContextMenu(ev.clientX,ev.clientY,'windows');});


window.addEventListener('beforeunload',ev=>{if(state.editor.dirty){ev.preventDefault();ev.returnValue='';}});

(async function init(){
  buildHelp();initTooltips();applyTheme(document.documentElement.dataset.theme||'light');updateDestinationUI();renderBreadcrumbs();updateSelectionUI();
  await loadSettings();maybeSuggestName();
  await Promise.all([navigate('/',false),buildTree()]);
  scheduleSessionExpiry();
})();
