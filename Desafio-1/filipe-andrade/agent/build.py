import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def build():
    project = Path(__file__).resolve().parent
    output = project / "dist" / "agent.zip"
    output.parent.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory(dir=output.parent) as temporary:
        work = Path(temporary)
        requirements = work / "requirements.txt"
        package = work / "package"
        subprocess.run(
            [
                "uv", "export", "--locked", "--no-dev", "--no-emit-project",
                "--format", "requirements.txt", "--output-file", str(requirements),
            ],
            cwd=project,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        subprocess.run(
            [
                "uv", "pip", "install", "--target", str(package),
                "--python-version", "3.13", "--python-platform", "aarch64-manylinux2014",
                "--only-binary", ":all:", "--require-hashes", "--no-deps",
                "-r", str(requirements),
            ],
            cwd=project,
            check=True,
        )
        for name in ("app.py", "payment_tools.py"):
            shutil.copyfile(project / name, package / name)

        archive = work / "agent.zip"
        with ZipFile(archive, "w") as bundle:
            for path in sorted(package.rglob("*")):
                if path.is_file() and path.suffix != ".pyc" and path.name != ".lock":
                    # Datas fixas evitam publicar outro asset quando o conteúdo é igual.
                    member = ZipInfo(path.relative_to(package).as_posix())
                    member.create_system = 3
                    member.external_attr = 0o100644 << 16
                    bundle.writestr(member, path.read_bytes(), compress_type=ZIP_DEFLATED)
        archive.replace(output)
    print(output)


if __name__ == "__main__":
    build()
