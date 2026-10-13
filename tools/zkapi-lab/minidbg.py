"""Tiny Win32 debugger: run a process, report the first-chance exception address, the registers and
the candidate return addresses on the stack, each mapped to module+offset (for llvm-symbolizer)."""
import ctypes, ctypes.wintypes as w, struct, sys

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

DEBUG_ONLY_THIS_PROCESS = 0x2
CREATE_NO_WINDOW = 0x08000000
EXCEPTION_DEBUG_EVENT, CREATE_PROCESS_DEBUG_EVENT, EXIT_PROCESS_DEBUG_EVENT, LOAD_DLL_DEBUG_EVENT = 1, 3, 5, 6
DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED = 0x00010002, 0x80010001
CONTEXT_FULL = 0x10000B
EXCEPTION_BREAKPOINT = 0x80000003

class STARTUPINFO(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]
class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]
class EXCEPTION_RECORD(ctypes.Structure):
    pass
EXCEPTION_RECORD._fields_ = [("ExceptionCode", w.DWORD), ("ExceptionFlags", w.DWORD),
                             ("ExceptionRecord", ctypes.POINTER(EXCEPTION_RECORD)), ("ExceptionAddress", ctypes.c_void_p),
                             ("NumberParameters", w.DWORD), ("ExceptionInformation", ctypes.c_size_t * 15)]
class EXCEPTION_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("ExceptionRecord", EXCEPTION_RECORD), ("dwFirstChance", w.DWORD)]
class LOAD_DLL_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("hFile", w.HANDLE), ("lpBaseOfDll", ctypes.c_void_p), ("dwDebugInfoFileOffset", w.DWORD),
                ("nDebugInfoSize", w.DWORD), ("lpImageName", ctypes.c_void_p), ("fUnicode", w.WORD)]
class CREATE_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("hFile", w.HANDLE), ("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("lpBaseOfImage", ctypes.c_void_p),
                ("dwDebugInfoFileOffset", w.DWORD), ("nDebugInfoSize", w.DWORD), ("lpThreadLocalBase", ctypes.c_void_p),
                ("lpStartAddress", ctypes.c_void_p), ("lpImageName", ctypes.c_void_p), ("fUnicode", w.WORD)]
class DEBUG_EVENT_U(ctypes.Union):
    _fields_ = [("Exception", EXCEPTION_DEBUG_INFO), ("CreateProcessInfo", CREATE_PROCESS_DEBUG_INFO),
                ("LoadDll", LOAD_DLL_DEBUG_INFO), ("raw", ctypes.c_byte * 160)]
class DEBUG_EVENT(ctypes.Structure):
    _fields_ = [("dwDebugEventCode", w.DWORD), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD), ("u", DEBUG_EVENT_U)]
class M128A(ctypes.Structure):
    _fields_ = [("Low", ctypes.c_ulonglong), ("High", ctypes.c_longlong)]
class CONTEXT(ctypes.Structure):
    _align_ = 16
    _fields_ = [("P1Home", ctypes.c_ulonglong), ("P2Home", ctypes.c_ulonglong), ("P3Home", ctypes.c_ulonglong),
                ("P4Home", ctypes.c_ulonglong), ("P5Home", ctypes.c_ulonglong), ("P6Home", ctypes.c_ulonglong),
                ("ContextFlags", w.DWORD), ("MxCsr", w.DWORD), ("SegCs", w.WORD), ("SegDs", w.WORD), ("SegEs", w.WORD),
                ("SegFs", w.WORD), ("SegGs", w.WORD), ("SegSs", w.WORD), ("EFlags", w.DWORD),
                ("Dr0", ctypes.c_ulonglong), ("Dr1", ctypes.c_ulonglong), ("Dr2", ctypes.c_ulonglong), ("Dr3", ctypes.c_ulonglong),
                ("Dr6", ctypes.c_ulonglong), ("Dr7", ctypes.c_ulonglong),
                ("Rax", ctypes.c_ulonglong), ("Rcx", ctypes.c_ulonglong), ("Rdx", ctypes.c_ulonglong), ("Rbx", ctypes.c_ulonglong),
                ("Rsp", ctypes.c_ulonglong), ("Rbp", ctypes.c_ulonglong), ("Rsi", ctypes.c_ulonglong), ("Rdi", ctypes.c_ulonglong),
                ("R8", ctypes.c_ulonglong), ("R9", ctypes.c_ulonglong), ("R10", ctypes.c_ulonglong), ("R11", ctypes.c_ulonglong),
                ("R12", ctypes.c_ulonglong), ("R13", ctypes.c_ulonglong), ("R14", ctypes.c_ulonglong), ("R15", ctypes.c_ulonglong),
                ("Rip", ctypes.c_ulonglong), ("FltSave", ctypes.c_byte * 512), ("VectorRegister", M128A * 26),
                ("VectorControl", ctypes.c_ulonglong), ("DebugControl", ctypes.c_ulonglong),
                ("LastBranchToRip", ctypes.c_ulonglong), ("LastBranchFromRip", ctypes.c_ulonglong),
                ("LastExceptionToRip", ctypes.c_ulonglong), ("LastExceptionFromRip", ctypes.c_ulonglong)]

k32.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p,
                               w.LPCWSTR, ctypes.POINTER(STARTUPINFO), ctypes.POINTER(PROCESS_INFORMATION)]
k32.WaitForDebugEvent.argtypes = [ctypes.POINTER(DEBUG_EVENT), w.DWORD]
k32.ContinueDebugEvent.argtypes = [w.DWORD, w.DWORD, w.DWORD]
k32.OpenThread.argtypes = [w.DWORD, w.BOOL, w.DWORD]; k32.OpenThread.restype = w.HANDLE
k32.GetThreadContext.argtypes = [w.HANDLE, ctypes.POINTER(CONTEXT)]
k32.ReadProcessMemory.argtypes = [w.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.GetFinalPathNameByHandleW.argtypes = [w.HANDLE, w.LPWSTR, w.DWORD, w.DWORD]

def path_of(h):
    buf = ctypes.create_unicode_buffer(1024)
    n = k32.GetFinalPathNameByHandleW(h, buf, 1024, 0)
    return buf.value[4:] if buf.value.startswith("\\\\?\\") else buf.value

def main():
    cmd = " ".join(f'"{a}"' for a in sys.argv[1:])
    si, pi = STARTUPINFO(), PROCESS_INFORMATION(); si.cb = ctypes.sizeof(si)
    ok = k32.CreateProcessW(None, cmd, None, None, False, DEBUG_ONLY_THIS_PROCESS | CREATE_NO_WINDOW, None, None, ctypes.byref(si), ctypes.byref(pi))
    if not ok: raise OSError(ctypes.get_last_error())
    mods = []  # (base, path)
    ev = DEBUG_EVENT(); exceptions = 0
    while True:
        if not k32.WaitForDebugEvent(ctypes.byref(ev), 60000): print("timeout"); break
        code, status = ev.dwDebugEventCode, DBG_CONTINUE
        if code == CREATE_PROCESS_DEBUG_EVENT:
            mods.append((ev.u.CreateProcessInfo.lpBaseOfImage, path_of(ev.u.CreateProcessInfo.hFile)))
        elif code == LOAD_DLL_DEBUG_EVENT:
            mods.append((ev.u.LoadDll.lpBaseOfDll, path_of(ev.u.LoadDll.hFile)))
        elif code == EXIT_PROCESS_DEBUG_EVENT:
            print("process exited"); break
        elif code == EXCEPTION_DEBUG_EVENT:
            rec = ev.u.Exception.ExceptionRecord
            if rec.ExceptionCode == EXCEPTION_BREAKPOINT and exceptions == 0:
                exceptions += 1  # initial breakpoint
            else:
                exceptions += 1
                def mod(addr):
                    best = None
                    for base, p in mods:
                        if base and addr >= base and (best is None or base > best[0]): best = (base, p)
                    return f"{best[1].split(chr(92))[-1]}+0x{addr - best[0]:x}" if best else "?"
                ea = rec.ExceptionAddress or 0
                print(f"exception 0x{rec.ExceptionCode:08x} first_chance={ev.u.Exception.dwFirstChance} at 0x{ea:x} ({mod(ea)})")
                if rec.ExceptionCode == 0xC0000005:
                    print(f"  access {'write' if rec.ExceptionInformation[0] else 'read'} at 0x{rec.ExceptionInformation[1]:x}")
                th = k32.OpenThread(0x1F03FF, False, ev.dwThreadId)
                ctx = CONTEXT(); ctx.ContextFlags = CONTEXT_FULL
                if k32.GetThreadContext(th, ctypes.byref(ctx)):
                    print(f"  rip=0x{ctx.Rip:x} rsp=0x{ctx.Rsp:x} rbp=0x{ctx.Rbp:x} rax=0x{ctx.Rax:x} rcx=0x{ctx.Rcx:x} rdx=0x{ctx.Rdx:x} r8=0x{ctx.R8:x} r9=0x{ctx.R9:x} rdi=0x{ctx.Rdi:x} rsi=0x{ctx.Rsi:x}")
                    data = b""
                    for off in range(0, 8192, 256):
                        buf = (ctypes.c_byte * 256)(); got = ctypes.c_size_t()
                        if not k32.ReadProcessMemory(pi.hProcess, ctx.Rsp + off, buf, 256, ctypes.byref(got)): break
                        data += bytes(buf)[:got.value]
                    words = struct.unpack(f"<{len(data) // 8}Q", data[:len(data) - len(data) % 8])
                    print(f"  stack read {len(data)} bytes; candidates (module+offset):")
                    shown = 0
                    for i, v in enumerate(words):
                        m = mod(v)
                        if m != "?" and shown < 40:
                            print(f"    [rsp+0x{i*8:x}] 0x{v:x} {m}"); shown += 1
                if ev.u.Exception.dwFirstChance:
                    status = DBG_EXCEPTION_NOT_HANDLED
                if exceptions > 3: break
        k32.ContinueDebugEvent(ev.dwProcessId, ev.dwThreadId, status)
    for b, p in mods: print(f"  module 0x{b:x} {p}")
main()
