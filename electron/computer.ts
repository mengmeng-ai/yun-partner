// Windows UIA computer operation — Phase 3, clean-room implementation.
// Windows-only by design (UI Automation is a Windows API). On Linux/macOS
// every function returns { supported: false, reason: 'Windows only' } and
// never throws — the UI must show that state instead of pretending.
// Controls are found BY NAME, never by fixed coordinates (per the public
// Aivy docs: read the control tree, find the button/input, then act).
// Every function returns { ok, detail } and never throws.

import { execFile } from 'child_process';

export interface ComputerResult {
  ok: boolean;
  supported: boolean;
  detail: string;
  /** Operation-specific payload (control tree, screenshot path, …). */
  data?: unknown;
}

export interface ControlInfo {
  name: string;
  controlType: string;
  automationId: string;
  /** Direct children (one level; deeper levels come from a second call). */
  children: { name: string; controlType: string; automationId: string }[];
}

const WINDOWS_ONLY: ComputerResult = {
  ok: false,
  supported: false,
  detail: '电脑操作仅支持 Windows（UI Automation 是 Windows API），当前系统不支持',
};

const isWindows = process.platform === 'win32';

interface PsRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runPowerShell(script: string, timeoutMs = 15_000): Promise<PsRun> {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? ''),
          stderr: err ? `${err.message} ${String(stderr ?? '')}`.trim() : String(stderr ?? ''),
        });
      },
    );
  });
}

/** Escape a value for embedding in a PowerShell single-quoted string. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const TREE_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$out = @()
foreach ($w in $wins) {
  $name = $w.Current.Name
  if (-not $name) { continue }
  $kids = @()
  $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $n = 0
  foreach ($c in $all) {
    if ($n -ge 200) { break }
    $cn = $c.Current.Name
    if (-not $cn) { continue }
    $kids += @{ name = $cn; controlType = $c.Current.ControlType.ProgrammaticName; automationId = $c.Current.AutomationId }
    $n++
  }
  $out += @{ name = $name; controlType = $w.Current.ControlType.ProgrammaticName; automationId = $w.Current.AutomationId; children = $kids }
}
$out | ConvertTo-Json -Depth 4 -Compress
`;

/**
 * List top-level windows + their controls as JSON.
 * Linux/macOS: { supported: false, reason: 'Windows only' }.
 */
export async function getControlTree(): Promise<ComputerResult> {
  if (!isWindows) return WINDOWS_ONLY;
  try {
    const run = await runPowerShell(TREE_SCRIPT);
    if (!run.ok || !run.stdout.trim()) {
      return { ok: false, supported: true, detail: `读取控件树失败：${run.stderr || '无输出'}` };
    }
    let data: unknown;
    try {
      data = JSON.parse(run.stdout) as unknown;
    } catch {
      return { ok: false, supported: true, detail: '控件树返回了无法解析的 JSON' };
    }
    const windows = Array.isArray(data) ? data : [data];
    return { ok: true, supported: true, detail: `找到 ${windows.length} 个顶层窗口`, data: windows };
  } catch (e) {
    return { ok: false, supported: true, detail: `读取控件树异常：${(e as Error).message}` };
  }
}

function findControlScript(name: string): string {
  // Finds the first element (any window) whose Name matches, searching
  // descendants. Returns $el or $null.
  return `
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ${psQuote(name)})
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($el -eq $null) { Write-Output 'NOTFOUND'; exit 0 }
Write-Output 'FOUND'
`;
}

/** Click a control by its name (Invoke / Select / Toggle pattern, in order). */
export async function clickControl(name: string): Promise<ComputerResult> {
  if (!isWindows) return WINDOWS_ONLY;
  if (!name.trim()) return { ok: false, supported: true, detail: '控件名不能为空' };
  const script = `
${findControlScript(name)}
if ($el -eq $null) { exit 0 }
try {
  $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pat.Invoke()
  Write-Output 'INVOKED'
} catch {
  try {
    $sel = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $sel.Select()
    Write-Output 'SELECTED'
  } catch {
    try {
      $tog = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $tog.Toggle()
      Write-Output 'TOGGLED'
    } catch {
      Write-Output 'NOTINVOKABLE'
    }
  }
}
`;
  try {
    const run = await runPowerShell(script);
    const out = run.stdout;
    if (out.includes('NOTFOUND')) return { ok: false, supported: true, detail: `找不到名为“${name}”的控件` };
    if (out.includes('INVOKED')) return { ok: true, supported: true, detail: `已点击“${name}”` };
    if (out.includes('SELECTED')) return { ok: true, supported: true, detail: `已选中“${name}”` };
    if (out.includes('TOGGLED')) return { ok: true, supported: true, detail: `已切换“${name}”` };
    if (out.includes('NOTINVOKABLE')) {
      return { ok: false, supported: true, detail: `找到了“${name}”，但它不能被点击（无 Invoke/Select/Toggle 模式）` };
    }
    return { ok: false, supported: true, detail: `点击失败：${run.stderr || '未知错误'}` };
  } catch (e) {
    return { ok: false, supported: true, detail: `点击异常：${(e as Error).message}` };
  }
}

/** Type text into a control by its name (ValuePattern, else focus + SendKeys). */
export async function typeIntoControl(name: string, text: string): Promise<ComputerResult> {
  if (!isWindows) return WINDOWS_ONLY;
  if (!name.trim()) return { ok: false, supported: true, detail: '控件名不能为空' };
  const script = `
${findControlScript(name)}
if ($el -eq $null) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms
try { $el.SetFocus() } catch { }
try {
  $val = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $val.SetValue(${psQuote(text)})
  Write-Output 'SETVALUE'
} catch {
  try {
    [System.Windows.Forms.SendKeys]::SendWait(${psQuote(text)})
    Write-Output 'SENDKEYS'
  } catch {
    Write-Output 'NOTEDITABLE'
  }
}
`;
  try {
    const run = await runPowerShell(script);
    const out = run.stdout;
    if (out.includes('NOTFOUND')) return { ok: false, supported: true, detail: `找不到名为“${name}”的控件` };
    if (out.includes('SETVALUE')) return { ok: true, supported: true, detail: `已在“${name}”里输入文字` };
    if (out.includes('SENDKEYS')) {
      return { ok: true, supported: true, detail: `已向“${name}”发送按键（回退方式：控件不支持直接设值）` };
    }
    if (out.includes('NOTEDITABLE')) {
      return { ok: false, supported: true, detail: `找到了“${name}”，但它不可编辑` };
    }
    return { ok: false, supported: true, detail: `输入失败：${run.stderr || '未知错误'}` };
  } catch (e) {
    return { ok: false, supported: true, detail: `输入异常：${(e as Error).message}` };
  }
}

/**
 * Screenshot the primary screen to a temp PNG (Windows only).
 * Returns { ok, data: { path } } on success.
 * Linux/macOS: { supported: false, reason: 'Windows only' }.
 */
export async function screenshot(): Promise<ComputerResult> {
  if (!isWindows) return WINDOWS_ONLY;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$stamp = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
$outPath = Join-Path $env:TEMP ('aivy-shot-' + $stamp + '.png')
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $outPath
`;
  try {
    const run = await runPowerShell(script);
    const filePath = run.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!run.ok || !filePath.toLowerCase().endsWith('.png')) {
      return { ok: false, supported: true, detail: `截图失败：${run.stderr || '无输出'}` };
    }
    return { ok: true, supported: true, detail: `截图已保存：${filePath}`, data: { path: filePath } };
  } catch (e) {
    return { ok: false, supported: true, detail: `截图异常：${(e as Error).message}` };
  }
}
