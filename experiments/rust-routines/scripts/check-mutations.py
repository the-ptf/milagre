#!/usr/bin/env python3
"""Compile isolated Rust semantic mutants and require the real Node oracle to reject each."""
import json
import pathlib
import runpy
import shutil
import subprocess
import tempfile

API=runpy.run_path(str(pathlib.Path(__file__).with_name('check-parity.py')))
CRATE=API['CRATE']
MUTATIONS=[
 ('strictly-after','schedule.rs','after_ms.div_euclid(MINUTE) * MINUTE + MINUTE','after_ms.div_euclid(MINUTE) * MINUTE'),
 ('dom-dow-or','schedule.rs','dom || dow','dom && dow'),
 ('first-repeated-minute','schedule.rs','instants.sort_unstable();','instants.sort_unstable_by(|a,b| b.cmp(a));'),
 ('skipped-spring-gap','schedule.rs','    Ok(None)','    Ok(Some(guess))'),
 ('eight-year-leap-cap','schedule.rs','from.date.year() + 8','from.date.year() + 1'),
 ('large-stride-first-value','cron.rs','if stride > f64::from(to - value) {','if stride > f64::from(to - value) { if stride > 255.0 { values.clear(); }'),
]

def main():
    API['build']()
    cases=API['corpus']()
    expected,baseline=API['outputs'](CRATE/'target/debug/examples/cron_fixture',cases)
    assert expected==baseline,'baseline must pass before mutation testing'
    target=CRATE/'target/mutation-build'
    killed=[]
    for name,file,before,after in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix='cron-mutant-',dir=CRATE/'target') as path:
            root=pathlib.Path(path)
            for folder in ['src','examples']: shutil.copytree(CRATE/folder,root/folder)
            for item in ['Cargo.toml','Cargo.lock']: shutil.copyfile(CRATE/item,root/item)
            source=root/'src'/file
            text=source.read_text();assert text.count(before)==1,name
            source.write_text(text.replace(before,after))
            subprocess.run(['cargo','build','--offline','--locked','--manifest-path',str(root/'Cargo.toml'),'--target-dir',str(target),'--example','cron_fixture'],check=True,capture_output=True,timeout=90)
            actual=subprocess.run([str(target/'debug/examples/cron_fixture')],input=json.dumps(cases).encode(),capture_output=True,check=True,timeout=60)
            actual=json.loads(actual.stdout)
            differences=[i for i,(a,b) in enumerate(zip(expected,actual)) if a!=b]
            assert differences and len(actual)==len(expected),f'mutant survived: {name}'
            killed.append({'mutation':name,'mismatches':len(differences),'firstCase':cases[differences[0]]})
            print(json.dumps(killed[-1]),flush=True)
    print(json.dumps({'compiledMutants':len(killed),'killedByActualNodeOracle':len(killed),'productionSourcesModified':False}),flush=True)

if __name__=='__main__': main()
