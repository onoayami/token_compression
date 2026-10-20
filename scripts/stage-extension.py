#!/usr/bin/env python3
"""Prepare a dependency-free extension directory for official `vsce package`."""
from pathlib import Path
import argparse,json,shutil
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--out',default=str(ROOT/'dist/extension'))
args=parser.parse_args()
out=Path(args.out).resolve()
if out==ROOT or (ROOT in out.parents and out != ROOT/'dist/extension'):
    raise SystemExit('Use dist/extension or a separate temporary output directory.')
if out.exists():
    raise SystemExit('Output exists. Use a new output directory; files are not silently deleted.')
out.mkdir(parents=True)
for name in ['package.json','extension.cjs','runtime.mjs','http.mjs','README.md']:
    shutil.copyfile(ROOT/'vscode-extension'/name,out/name)
shutil.copyfile(ROOT/'LICENSE',out/'LICENSE')
for folder in ['src','project-context','integration/prompts']:
    source=ROOT/folder;target=out/'kit'/folder
    target.mkdir(parents=True,exist_ok=True)
    for p in source.rglob('*'):
        if p.is_symlink():
            raise SystemExit('Unexpected symlinked package input')
        if p.is_file():
            relative=p.relative_to(source)
            if any(s in {'.context-kit-cache','.context-kit','node_modules','.git'} for s in relative.parts):
                raise SystemExit('Unexpected private/symlinked package input')
            destination=target/relative;destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(p,destination)
manifest=json.loads((out/'package.json').read_text())
if not (out/manifest['main']).is_file():raise SystemExit('Missing extension entrypoint')
if (out/'node_modules').exists():raise SystemExit('Unexpected dependencies')
print('Staged extension:',manifest['version'],'files:',sum(p.is_file() for p in out.rglob('*')))
