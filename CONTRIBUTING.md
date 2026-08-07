# Contributing to Plexar Studio

Thank you for your interest in contributing to Plexar Studio! This guide will help you get started.

## Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/NovemberFalls/plexar-studio.git
   cd plexar-studio
   ```

2. **Install backend dependencies:**
   ```bash
   pip install -r web/requirements.txt
   ```

3. **Install frontend dependencies:**
   ```bash
   cd web/frontend && npm install
   ```

4. **Start the backend:**
   ```bash
   cd web && python server.py
   ```
   The FastAPI server starts on port 8420.

5. **Start the frontend dev server:**
   ```bash
   cd web/frontend && npm run dev
   ```
   Vite dev server runs on port 5174 and proxies API calls to the backend.

## Code Style

### Python
- Use `cockpit.*` loggers via `logging.getLogger()`. No `print()` statements.
- Follow standard Python conventions (PEP 8).

### Frontend
- **CSS:** Use hover utility classes defined in `index.css` (e.g., `hover-bg-surface`, `hover-color-red`) instead of JavaScript `onMouseEnter`/`onMouseLeave` handlers.
- **React components:** Sidebar sub-components (`SessionItem`, `LocationNode`, `InstanceGroup`) must be defined at module scope, not nested inside parent components. Pass all dependencies via props.
- **Themes:** 10 color palettes with dark/light variants are defined in `themeData.js`. Use the `useTheme` hook for theme context.

## Testing

### Backend tests
```bash
cd web && python -m pytest tests/ -v
```
Currently 74 tests. All must pass before submitting a PR.

### Frontend tests
```bash
cd web/frontend && npm test
```
Currently 70 tests. All must pass before submitting a PR.

### Lint
```bash
cd web/frontend && npm run lint
```

## Pull Request Process

1. Fork the repository.
2. Create a feature branch from `master`.
3. Make your changes, ensuring all tests pass and lint is clean.
4. Submit a pull request against `master`.
5. CI must pass before the PR will be reviewed.
6. A maintainer will review your PR and may request changes.

## Platform

Plexar Studio uses ConPTY/pywinpty on Windows and ptyprocess on Linux/macOS. The pre-built desktop app targets **Windows 10/11**. Running from source works on **Linux and macOS** via the `unix_pty.py` backend.

Please test changes on Windows before submitting a PR. If your change touches `pty_manager.py` or `pty_backend.py`, verify it doesn't break the platform-routing logic in `get_backend()`.

## License

By contributing to Plexar Studio, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0.
