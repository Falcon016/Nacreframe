---
name: python-env
description: Find, check and repair a project's Python environment (interpreter, virtual environment, missing or conflicting packages). Use when Python code fails with ImportError/ModuleNotFoundError, the wrong Python runs, pip complains, or before working on a Python project for the first time.
---

Work through these steps in order. Run each command and read its output before moving on; do not guess what an
environment contains.

## 1. Find what the project expects

- Look for, in this order: `pyproject.toml`, `requirements*.txt`, `setup.py`/`setup.cfg`, `Pipfile`, `poetry.lock`,
  `uv.lock`, `environment.yml`, `.python-version`, `runtime.txt`.
- Note the Python version it asks for (`requires-python`, `.python-version`) and which tool manages it:
  - `uv.lock` → uv
  - `poetry.lock` → Poetry
  - `Pipfile` → pipenv
  - `environment.yml` → conda
  - anything else → pip with a venv
- Use the project's own tool for every later step. Mixing pip into a Poetry or conda environment causes the
  conflicts you are trying to fix.

## 2. Find the interpreter that actually runs

```sh
which -a python python3 2>/dev/null; python3 --version
ls -d .venv venv env 2>/dev/null
```

- On Windows, use `where python` and `py -0p` instead.
- If a venv exists, use its interpreter explicitly (`.venv/bin/python`, or `.venv\Scripts\python.exe` on Windows),
  not whatever `python` resolves to.
- Confirm with `<venv python> -c "import sys; print(sys.executable, sys.version)"`.
- If there is no venv and the project uses pip, create one: `python3 -m venv .venv`. Never install packages into
  the system Python, and never use `sudo pip`.

## 3. Check what is installed against what is required

```sh
<venv python> -m pip --version
<venv python> -m pip check
<venv python> -m pip list --format=freeze
```

- `pip check` reports broken or conflicting requirements. Fix those first.
- Compare against the requirements file. Missing packages: `<venv python> -m pip install -r requirements.txt`, or the
  project tool's own sync command (`uv sync`, `poetry install`, `pipenv install`).
- Packages whose import name differs from their install name are common causes of ImportError:
  - `cv2` → `opencv-python` (or `opencv-python-headless` on servers)
  - `PIL` → `Pillow`
  - `yaml` → `PyYAML`
  - `sklearn` → `scikit-learn`
  - `bs4` → `beautifulsoup4`
  - `dotenv` → `python-dotenv`
- Do not install both `opencv-python` and `opencv-python-headless`: they overwrite each other. Keep one.

## 4. Reproduce the original failure

- Run the exact command that failed, with the venv's interpreter, and read the full traceback.
- An ImportError that names a package you just confirmed is installed usually means the wrong interpreter. Go back
  to step 2.
- Native build failures ("Failed building wheel") need system headers or a compiler. Report what is missing (for
  example `python3-dev`, `build-essential`) instead of retrying in a loop.

## 5. Make the fix stick

- Pin what you added in the project's requirements file or lock file, so the next install reproduces it.
- If you changed which interpreter or venv is used, say so in your report, with the activation command
  (`source .venv/bin/activate`, or `.venv\Scripts\activate` on Windows).

## Report

End with a short summary covering:

- the interpreter and venv in use;
- what was missing or conflicting;
- the commands you ran to fix it;
- whether the original failure is gone (with the command that proves it);
- anything still broken.
