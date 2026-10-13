import ctypes, ctypes.wintypes as w, socket, sys
ws = ctypes.WinDLL("ws2_32", use_last_error=True)
ws.WSAIoctl.argtypes = [ctypes.c_size_t, w.DWORD, ctypes.c_void_p, w.DWORD, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.c_void_p, ctypes.c_void_p]
ws.WSAGetLastError.restype = ctypes.c_int
SIO_BASE_HANDLE, SIO_BSD_HANDLE_SELECT, SIO_BSD_HANDLE_POLL = 0x48000022, 0x48000024, 0x48000025
SIO_GET_EXTENSION_FUNCTION_POINTER = 0xC8000006
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0)); s.listen(1)
print("socket handle", s.fileno(), flush=True)
for name, code in [("SIO_BASE_HANDLE", SIO_BASE_HANDLE), ("SIO_BSD_HANDLE_SELECT", SIO_BSD_HANDLE_SELECT), ("SIO_BSD_HANDLE_POLL", SIO_BSD_HANDLE_POLL)]:
    out = ctypes.c_size_t(0); n = w.DWORD(0)
    r = ws.WSAIoctl(s.fileno(), code, None, 0, ctypes.byref(out), ctypes.sizeof(out), ctypes.byref(n), None, None)
    print(f"{name}: rc={r} err={ws.WSAGetLastError() if r else 0} base=0x{out.value:x}", flush=True)
# WSAPROTOCOL_INFO: is the socket an IFS handle?
buf = ctypes.create_string_buffer(1024); ln = ctypes.c_int(1024)
ws.getsockopt.argtypes = [ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
SOL_SOCKET, SO_PROTOCOL_INFOW = 0xFFFF, 0x2005
r = ws.getsockopt(s.fileno(), SOL_SOCKET, SO_PROTOCOL_INFOW, buf, ctypes.byref(ln))
flags1 = int.from_bytes(buf.raw[0:4], "little")
print(f"SO_PROTOCOL_INFOW rc={r} dwServiceFlags1=0x{flags1:x} XP1_IFS_HANDLES={'yes' if flags1 & 0x20000 else 'NO'}", flush=True)
# extension function pointers (ConnectEx / AcceptEx) — null pointers would explain rip=0 crashes
import uuid
for name, guid in [("AcceptEx", "{b5367df1-cbac-11cf-95ca-00805f48a192}"), ("ConnectEx", "{25a207b9-ddf3-4660-8ee9-76e58c74063e}"), ("GetAcceptExSockaddrs", "{b5367df2-cbac-11cf-95ca-00805f48a192}")]:
    g = uuid.UUID(guid).bytes_le; fn = ctypes.c_void_p(0); n = w.DWORD(0)
    r = ws.WSAIoctl(s.fileno(), SIO_GET_EXTENSION_FUNCTION_POINTER, g, 16, ctypes.byref(fn), 8, ctypes.byref(n), None, None)
    print(f"{name}: rc={r} err={ws.WSAGetLastError() if r else 0} ptr=0x{fn.value or 0:x}", flush=True)
