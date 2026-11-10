// Orbit — controlling any Windows app through Microsoft UI Automation (the accessibility layer
// screen readers use). Each call runs a short PowerShell script; no extra installs needed.
const { spawn } = require('child_process');

const NATIVE = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ([System.Management.Automation.PSTypeName]'OrbitWin').Type) {
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class OrbitWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static void Click(int x, int y, bool right, bool dbl) {
    SetCursorPos(x, y);
    uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
    int n = dbl ? 2 : 1;
    for (int i = 0; i < n; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); }
  }
  public static void Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
}
"@
}
[void][OrbitWin]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'Stop'
$AE = [System.Windows.Automation.AutomationElement]
`;

function runPS(script, timeoutMs = 30000) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows app control only works on Windows.'));
  const encoded = Buffer.from(NATIVE + '\n' + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    const t = setTimeout(() => { p.kill(); reject(new Error('Windows took too long to answer.')); }, timeoutMs);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', () => {
      clearTimeout(t);
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); } catch { reject(new Error((err || out || 'No answer from PowerShell').trim().slice(0, 500))); }
    });
  });
}

const q = (v) => "'" + String(v ?? '').replace(/'/g, "''") + "'"; // PowerShell single-quoted literal

const INTERACTIVE = ['Button', 'Edit', 'Document', 'MenuItem', 'ListItem', 'TabItem', 'CheckBox', 'RadioButton', 'Hyperlink', 'ComboBox', 'TreeItem', 'SplitButton', 'MenuBar', 'Menu', 'DataItem', 'Slider', 'Spinner'];

class WinUI {
  constructor() { this.refs = new Map(); this.hwnd = null; }

  async listWindows() {
    const r = await runPS(`
$list = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
  Select-Object @{n='hwnd';e={[int64]$_.MainWindowHandle}}, @{n='app';e={$_.ProcessName}}, @{n='title';e={$_.MainWindowTitle}}
ConvertTo-Json -Compress @($list)`);
    const arr = Array.isArray(r) ? r : [r];
    return arr.map(w => `${w.hwnd} | ${w.app} | ${w.title}`).join('\n') || '(no windows)';
  }

  async _resolveWindow(target) {
    if (/^\d+$/.test(String(target || ''))) return String(target);
    const r = await runPS(`
$t = ${q(target)}
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -like "*$t*" -or $_.ProcessName -like "*$t*") } | Select-Object -First 1
if ($p) { ConvertTo-Json -Compress @{ hwnd = [int64]$p.MainWindowHandle; title = $p.MainWindowTitle } } else { ConvertTo-Json -Compress @{ hwnd = 0 } }`);
    if (!r.hwnd) throw new Error(`No open window matches "${target}". Use windows_list to see what is open.`);
    return String(r.hwnd);
  }

  async focus(target) {
    const hwnd = await this._resolveWindow(target);
    await runPS(`[OrbitWin]::Focus([IntPtr]${hwnd}); Start-Sleep -Milliseconds 250; ConvertTo-Json -Compress @{ ok = $true }`);
    this.hwnd = hwnd;
    return `Focused window ${hwnd}.`;
  }

  async snapshot(target) {
    const hwnd = target ? await this._resolveWindow(target) : this.hwnd;
    if (!hwnd) throw new Error('Say which window: give its title, app name, or handle from windows_list.');
    this.hwnd = hwnd;
    const types = INTERACTIVE.map(t => `'${t}'`).join(',');
    const r = await runPS(`
$root = $AE::FromHandle([IntPtr]${hwnd})
$want = @(${types})
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$items = New-Object System.Collections.ArrayList
foreach ($e in $all) {
  if ($items.Count -ge 160) { break }
  try {
    $c = $e.Current
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
    if ($want -notcontains $type -or $c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    if ($r.Width -lt 2 -or $r.Height -lt 2) { continue }
    $val = ''
    try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $val = $vp.Current.Value } catch {}
    [void]$items.Add(@{ t = $type; n = $c.Name; a = $c.AutomationId; v = "$val"; x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); en = $c.IsEnabled })
  } catch {}
}
ConvertTo-Json -Compress -Depth 3 @{ title = $root.Current.Name; items = @($items) }`, 45000);
    this.refs.clear();
    const lines = (r.items || []).map((it, i) => {
      const ref = i + 1;
      this.refs.set(ref, { ...it, hwnd });
      const v = it.v ? ` value="${String(it.v).slice(0, 40)}"` : '';
      return `[${ref}] ${it.t} "${String(it.n || it.a || '').slice(0, 70)}"${v}${it.en === false ? ' [disabled]' : ''}`;
    });
    return `Window: ${r.title} (${hwnd})\nControls (use the number as ref):\n${lines.join('\n') || '(no controls exposed; try screenshot + mouse_click)'}`;
  }

  _ref(ref) {
    const it = this.refs.get(Number(ref));
    if (!it) throw new Error('Unknown ref. Take a fresh ui_snapshot first.');
    return it;
  }

  // Find the element again by name/automation id/type; fall back to its last known position.
  _findScript(it) {
    return `
$root = $AE::FromHandle([IntPtr]${it.hwnd})
$conds = New-Object System.Collections.ArrayList
if (${q(it.a)} -ne '') { [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, ${q(it.a)}))) }
if (${q(it.n)} -ne '') { [void]$conds.Add((New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, ${q(it.n)}))) }
$el = $null
if ($conds.Count -eq 2) { $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.AndCondition($conds[0], $conds[1]))) }
elseif ($conds.Count -eq 1) { $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $conds[0]) }
`;
  }

  async click(ref, opts = {}) {
    const it = this._ref(ref);
    const r = await runPS(`${this._findScript(it)}
[OrbitWin]::Focus([IntPtr]${it.hwnd}); Start-Sleep -Milliseconds 150
$how = 'mouse'
if ($el -and -not ${opts.right || opts.double ? '$true' : '$false'}) {
  try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $how = 'invoke' } catch {
    try { $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); $p.Toggle(); $how = 'toggle' } catch {
      try { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $how = 'select' } catch {
        try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $how = 'expand' } catch {} } } }
}
if ($how -eq 'mouse') {
  $x = ${it.x}; $y = ${it.y}
  if ($el) { $b = $el.Current.BoundingRectangle; if ($b.Width -gt 0) { $x = [int]($b.X + $b.Width / 2); $y = [int]($b.Y + $b.Height / 2) } }
  [OrbitWin]::Click($x, $y, ${opts.right ? '$true' : '$false'}, ${opts.double ? '$true' : '$false'})
}
Start-Sleep -Milliseconds 400
ConvertTo-Json -Compress @{ how = $how }`);
    return `Clicked [${ref}] "${it.n || it.a}" (${r.how}). Take a ui_snapshot to see the result.`;
  }

  async type(ref, text, submit) {
    const it = this._ref(ref);
    const r = await runPS(`${this._findScript(it)}
[OrbitWin]::Focus([IntPtr]${it.hwnd}); Start-Sleep -Milliseconds 150
$how = 'keys'
if ($el) {
  try { $el.SetFocus() } catch {}
  try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue(${q(text)}); $how = 'value' } catch {}
} else { [OrbitWin]::Click(${it.x}, ${it.y}, $false, $false) }
if ($how -eq 'keys') {
  Set-Clipboard -Value ${q(text)}
  [System.Windows.Forms.SendKeys]::SendWait('^a'); [System.Windows.Forms.SendKeys]::SendWait('^v')
}
${submit ? "Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')" : ''}
Start-Sleep -Milliseconds 300
ConvertTo-Json -Compress @{ how = $how }`);
    return `Typed into [${ref}] (${r.how})${submit ? ' and pressed Enter' : ''}.`;
  }

  async keys(keys) {
    // SendKeys syntax: ^ = Ctrl, % = Alt, + = Shift, {ENTER}, {TAB}, {F5}, ^s, %{F4}
    await runPS(`${this.hwnd ? `[OrbitWin]::Focus([IntPtr]${this.hwnd}); Start-Sleep -Milliseconds 150` : ''}
[System.Windows.Forms.SendKeys]::SendWait(${q(keys)}); Start-Sleep -Milliseconds 300
ConvertTo-Json -Compress @{ ok = $true }`);
    return `Sent keys ${keys}.`;
  }

  async mouseClick(x, y, button, double) {
    await runPS(`[OrbitWin]::Click(${Math.round(x)}, ${Math.round(y)}, ${button === 'right' ? '$true' : '$false'}, ${double ? '$true' : '$false'}); Start-Sleep -Milliseconds 300
ConvertTo-Json -Compress @{ ok = $true }`);
    return `Clicked at ${Math.round(x)}, ${Math.round(y)}.`;
  }
}

module.exports = { WinUI, runPS };
