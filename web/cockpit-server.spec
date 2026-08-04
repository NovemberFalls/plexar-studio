# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for cockpit-server (Tauri sidecar)

import os

block_cipher = None
root = os.path.dirname(os.path.abspath(SPEC))
frontend_dist = os.path.join(root, 'frontend', 'dist')

# No winpty DLLs needed — we use a pure-ctypes ConPTY wrapper (conpty.py)
# that calls the Windows ConPTY API directly, bypassing pywinpty's C
# extension which causes 0xC0000142 in PyInstaller onefile bundles.

a = Analysis(
    [os.path.join(root, 'server.py')],
    pathex=[root],
    binaries=[],
    datas=[
        (frontend_dist, 'frontend_dist'),
        # GET /api/version reads the app version out of package.json -- the same
        # file tauri.conf.json points at and vite injects as VITE_APP_VERSION.
        # Without it bundled, _app_version() finds nothing in the sidecar and the
        # endpoint reports app: null in the DESKTOP build while being correct in
        # dev, which is the worst way for a version to be wrong.
        (os.path.join(os.path.dirname(frontend_dist), 'package.json'), '.'),
    ],
    hiddenimports=[
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'starlette',
        'starlette.middleware',
        'starlette.routing',
        'starlette.responses',
        'fastapi',
        'fastapi.responses',
        'winpty',
        'conpty',
        'dotenv',
        'websockets',
        'httpx',
        'multipart',
        'python_multipart',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='claude-cockpit',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    icon=os.path.join(root, 'frontend', 'src-tauri', 'icons', 'icon.ico'),
)
