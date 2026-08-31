"""
Version management utilities for Chatterbox TTS API
"""

import os
import sys
from pathlib import Path
from typing import Dict, Any, Optional

try:
    import tomllib
except ImportError:
    # Python < 3.11 fallback
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

__version__ = "2.1.0"  # Fallback version
__all__ = ["get_version", "get_version_info", "__version__"]


def _read_pyproject_toml() -> Optional[Dict[str, Any]]:
    """Read pyproject.toml file from project root"""
    try:
        # Find the pyproject.toml file (go up from current file to project root)
        current_file = Path(__file__)
        project_root = current_file.parent.parent.parent  # app/core/version.py -> project root
        pyproject_path = project_root / "pyproject.toml"
        
        if not pyproject_path.exists():
            return None
            
        if tomllib is None:
            # Fallback: simple text parsing for version
            try:
                with open(pyproject_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    for line in content.split('\n'):
                        if line.strip().startswith('version = '):
                            # Extract version from line like: version = "1.0.0"
                            version_str = line.split('=')[1].strip().strip('"\'')
                            return {"project": {"version": version_str}}
            except Exception:
                pass
            return None
        
        # Use tomllib for proper TOML parsing
        with open(pyproject_path, 'rb') as f:
            return tomllib.load(f)
            
    except Exception as e:
        print(f"Warning: Could not read pyproject.toml: {e}")
        return None


def get_version() -> str:
    """Get the current API version"""
    pyproject_data = _read_pyproject_toml()
    
    if pyproject_data and "project" in pyproject_data and "version" in pyproject_data["project"]:
        return pyproject_data["project"]["version"]
    
    # Fallback to module-level version
    return __version__


def get_version_info() -> Dict[str, Any]:
    """Get comprehensive version information"""
    version = get_version()
    pyproject_data = _read_pyproject_toml()
    
    info = {
        "version": version,
        "api_version": version,
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "platform": sys.platform
    }
    
    # Add project metadata if available
    if pyproject_data and "project" in pyproject_data:
        project = pyproject_data["project"]
        info.update({
            "name": project.get("name", "chatterbox-tts-api"),
            "description": project.get("description", ""),
            "license": project.get("license", {}).get("text", "Unknown"),
            "requires_python": project.get("requires-python", ">=3.11")
        })
        
        # Add author info if available
        authors = project.get("authors", [])
        if authors:
            info["author"] = authors[0].get("name", "Unknown")
            info["author_email"] = authors[0].get("email", "")
    
    return info


# Update module version on import
__version__ = get_version() 