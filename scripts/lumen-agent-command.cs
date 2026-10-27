using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Management.Automation;
using System.Text;
using System.Threading;

// PowerShell 5.1 can corrupt quotes when it invokes a native command or a CMD
// shim. A binary cmdlet receives the original strings without a script file,
// so it also works under Restricted and AllSigned execution policies.
[Cmdlet("Invoke", "Lumen")]
[Alias("lumen")]
public sealed class InvokeLumenCommand : PSCmdlet {
    private Process child;

    [Parameter(ValueFromRemainingArguments = true)]
    public string[] Remaining { get; set; }

    private sealed class OutputLine {
        public string Text;
        public bool Error;
    }

    protected override void ProcessRecord() {
        var runtime = Environment.GetEnvironmentVariable("LUMEN_AGENT_RUNTIME");
        var helper = Environment.GetEnvironmentVariable("LUMEN_AGENT_CLI");
        if (string.IsNullOrEmpty(runtime) || string.IsNullOrEmpty(helper))
            throw new InvalidOperationException("Lumen's agent runtime is not configured. Start a new chat and try again.");

        var args = Remaining ?? new string[0];
        var encoded = new string[args.Length];
        for (var i = 0; i < args.Length; i++)
            encoded[i] = Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i] ?? ""));
        var transport = Path.Combine(Path.GetTempPath(), "lumen-agent-" + Guid.NewGuid().ToString("N") + ".args");
        try {
            File.WriteAllText(transport, args.Length + ":" + string.Join(",", encoded), new UTF8Encoding(false));
            var start = new ProcessStartInfo {
                FileName = runtime,
                Arguments = "-e \"require(Buffer.from(process.env.LUMEN_AGENT_CLI_BASE64,'base64').toString('utf8'))\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = SessionState.Path.CurrentFileSystemLocation.Path,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            // Keep a possibly non-ASCII install path out of the native command line
            // and the legacy Windows environment encoding.
            start.EnvironmentVariables["LUMEN_AGENT_CLI_BASE64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(helper));
            start.EnvironmentVariables["LUMEN_AGENT_ARGS_FILE"] = transport;
            var lines = new BlockingCollection<OutputLine>();
            var ended = 0;
            child = new Process { StartInfo = start };
            DataReceivedEventHandler output = delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null) { if (Interlocked.Increment(ref ended) == 2) lines.CompleteAdding(); return; }
                lines.Add(new OutputLine { Text = e.Data, Error = false });
            };
            DataReceivedEventHandler error = delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null) { if (Interlocked.Increment(ref ended) == 2) lines.CompleteAdding(); return; }
                lines.Add(new OutputLine { Text = e.Data, Error = true });
            };
            child.OutputDataReceived += output;
            child.ErrorDataReceived += error;
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            var errorLines = new System.Collections.Generic.List<string>();
            foreach (var line in lines.GetConsumingEnumerable()) {
                // Native stderr is diagnostic output, not a terminating cmdlet
                // error. Wait for the real process status before choosing how to
                // report it, so ErrorActionPreference=Stop cannot strand a child.
                if (line.Error) errorLines.Add(line.Text);
                else WriteObject(line.Text);
            }
            child.WaitForExit();
            SessionState.PSVariable.Set("LASTEXITCODE", child.ExitCode);
            if (child.ExitCode != 0) {
                var message = errorLines.Count > 0 ? string.Join(Environment.NewLine, errorLines) : "Lumen command failed with exit code " + child.ExitCode + ".";
                WriteError(new ErrorRecord(new Exception(message), "LumenAgentError", ErrorCategory.NotSpecified, null));
            } else {
                foreach (var line in errorLines) Console.Error.WriteLine(line);
            }
        } finally {
            if (child != null) {
                try { if (!child.HasExited) child.Kill(); } catch { }
                child.Dispose(); child = null;
            }
            try { File.Delete(transport); } catch { }
        }
    }

    protected override void StopProcessing() {
        var process = child;
        if (process != null) {
            try { if (!process.HasExited) process.Kill(); } catch { }
        }
    }
}
