"""Run a program with the Windows mitigation policy "block non-Microsoft-signed DLLs".

Why: this machine has a third-party Winsock Layered Service Provider (C:\\Windows\\System32\\ASProxy64.dll,
"ASProxy over MSAFD Tcpip" in `netsh winsock show catalog`). ws2_32 loads it into every process that
opens a socket, and it crashes Rust programs that use overlapped I/O through mio/tokio (anvil, the
zkAPI daemons, rustup) and breaks cargo's libcurl connections. With the signature policy the LSP DLL
fails to load, Winsock falls back to the base MSAFD provider, and the program runs normally. This is a
per-process, documented Windows API (PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY); no admin, no registry.

Usage: python nolsp.py <program> [args...]      (stdio inherited; exits with the child's exit code)
"""
import ctypes, ctypes.wintypes as w, os, sys

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY = 0x00020007
BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON = 0x0000100000000000
INFINITE = 0xFFFFFFFF

class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]
class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]
class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]

k32.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.c_size_t)]
k32.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p,
                               w.LPCWSTR, ctypes.POINTER(STARTUPINFOEXW), ctypes.POINTER(PROCESS_INFORMATION)]
k32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
k32.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]

def quote(a):
    if a and not any(c in a for c in ' \t"'): return a
    out, bs = '"', 0
    for c in a:
        if c == "\\": bs += 1
        elif c == '"': out += "\\" * (bs * 2 + 1) + c; bs = 0
        else: out += "\\" * bs + c; bs = 0
    return out + "\\" * (bs * 2) + '"'

def main(argv):
    if not argv: print(__doc__); return 2
    size = ctypes.c_size_t()
    k32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
    attrs = ctypes.create_string_buffer(size.value)
    if not k32.InitializeProcThreadAttributeList(attrs, 1, 0, ctypes.byref(size)): raise ctypes.WinError(ctypes.get_last_error())
    policy = ctypes.c_ulonglong(BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON)
    if not k32.UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, ctypes.byref(policy), ctypes.sizeof(policy), None, None):
        raise ctypes.WinError(ctypes.get_last_error())
    si = STARTUPINFOEXW(); si.StartupInfo.cb = ctypes.sizeof(si); si.lpAttributeList = ctypes.cast(attrs, ctypes.c_void_p)
    pi = PROCESS_INFORMATION()
    cmd = ctypes.create_unicode_buffer(" ".join(quote(a) for a in argv))
    if not k32.CreateProcessW(None, cmd, None, None, True, EXTENDED_STARTUPINFO_PRESENT, None, None, ctypes.byref(si), ctypes.byref(pi)):
        raise ctypes.WinError(ctypes.get_last_error())
    k32.WaitForSingleObject(pi.hProcess, INFINITE)
    code = w.DWORD(); k32.GetExitCodeProcess(pi.hProcess, ctypes.byref(code))
    return code.value & 0xFFFFFFFF

if __name__ == "__main__":
    rc = main(sys.argv[1:])
    sys.exit(rc if rc < 256 else (rc >> 24) or 1)  # keep NTSTATUS crashes visible (0xC0000005 -> 0xC0 = 192)
