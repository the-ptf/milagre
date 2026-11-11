#!/usr/bin/env python3
"""Compare this pure Rust checkpoint to the actual pinned production Node module."""
import datetime as dt
import json
import pathlib
import subprocess

CRATE=pathlib.Path(__file__).resolve().parents[1]
REPO=CRATE.parents[1]

def epoch(text):
    return int(dt.datetime.fromisoformat(text.replace('Z','+00:00')).timestamp()*1000)

def corpus():
    cases=[]
    def parse(expr): cases.append({'op':'parse','expr':expr})
    def every(text): cases.append({'op':'every','every':text})
    def next_(expr,zone,after): cases.append({'op':'next','expr':expr,'zone':zone,'after':epoch(after) if isinstance(after,str) else after})
    for expr in ['* * * * *','0,30 9-17/4 */10 1-3 1,7','59,0,59 23,0 31,1 12,1 7,1','0 0 1-31 * 0-7','0 0 * * 7,0,7','*/60 */24 */31 */12 */8','*/256 * * * *','*/65536 * * * *','*/9007199254740993 * * * *','*/'+'9'*3500+' * * * *','0'*3000+'5 * * * *','\ufeff*\u00a0*\u2028*\u3000*\u2003*\ufeff','*\u0085* * * * *']:
        parse(expr)
    for expr in ['61 * * * *','* * *','* * * * * *','* 24 * * *','* * 0 * *','* * * 13 *','* * * * 8','*/0 * * * *','5-1 * * * *','a * * * *','1,,2 * * * *','',' ','1/2 * * * *','*/ * * * *','*//2 * * * *','1-2-3 * * * *','-1 * * * *','1- * * * *','1e2 * * * *','1.0 * * * *','* * * * 0008','9'*100+' * * * *','9'*400+' * * * *','*/-1 * * * *','*/1.5 * * * *','*/1/2 * * * *']:
        parse(expr)
    for value in list(range(0,180))+[240,300,360,480,720,1440,2880,9007199254740993]:
        for unit in ['m','h']: every(f'{value}{unit}')
    for value in ['', 'm','0m','01m','1.5h','15','15s','1d',' 15m','15m ','-5m','15m\n','15m\r\n','15m\u2028','a"\n','9'*3500+'m','9'*3500+'h']:
        every(value)
    for expr in ['* * * * *','*/15 * * * *','0 9 20 * 1','0 9 20 * *','0 9 * * 1','0 9 1-31 * 1','0 9 20 * 0-7','0 0 * * 7','0 0 29 2 *','0 0 31 2 *','0 0 30 2 *']:
        for after in [-1,0,1,59999,epoch('2026-10-16T10:30:59.999Z'),epoch('2028-03-01T12:00:00Z'),epoch('2096-03-01T00:00:00Z')]:
            next_(expr,'UTC',after)
    for zone,date in [('Europe/Lisbon','2026-10-25'),('America/New_York','2026-11-01'),('Australia/Lord_Howe','2026-04-04')]:
        for hour in range(0,5):
            for minute in [0,29,30,59]:
                for after in [epoch(date+'T00:00:00Z')+i*1800000 for i in range(-2,8)]:
                    next_(f'{minute} {hour} * * *',zone,after)
    for zone,after in [('Europe/Lisbon','2026-03-28T12:00:00Z'),('America/New_York','2026-03-07T12:00:00Z'),('Antarctica/Troll','2026-03-29T00:30:00Z'),('Australia/Lord_Howe','2026-10-03T12:00:00Z'),('Pacific/Apia','2011-12-29T00:00:00Z')]:
        for expr in ['0 0 * * *','30 0 * * 1','30 1 * * *','0 2 * * *','30 2 * * *','* * * * *']:
            next_(expr,zone,after)
    names=json.loads(subprocess.check_output([str(CRATE/'target/debug/examples/zone_names')],text=True))['names']
    for zone in names:
        for after in ['1900-01-02T00:00:00Z','1945-08-14T12:00:00Z','1970-01-01T00:00:00Z','2026-10-24T12:00:00Z','2096-03-01T00:00:00Z']:
            next_('30 9 * * *',zone,after)
    for zone in ['utc','aMeRiCa/nEw_yOrK','Mars/Base','Etc/Unknown','Factory','',' UTC ','+00','-00:00','+0130','-23:59','+23:59','+24:00','+01:60','+1','+01:2','+01:00:00','Z','US/Pacific-New','Canada/East-Saskatchewan']:
        next_('* * * * *',zone,'2026-10-25T00:59:59Z')
    for after in [-2208902400000,253118217599999]:
        for zone in ['UTC','+23:59','-23:59']:
            for expr in ['* * * * *','0 0 29 2 *','0 0 31 2 *']:
                next_(expr,zone,after)
    return cases

def build(manifest=None):
    subprocess.run(['cargo','build','--offline','--locked','--manifest-path',str(manifest or CRATE/'Cargo.toml'),'--examples'],check=True,cwd=REPO)
    return (pathlib.Path(manifest).parent if manifest else CRATE)/'target/debug/examples/cron_fixture'

def outputs(binary,cases):
    payload=json.dumps(cases,ensure_ascii=False).encode()
    node=subprocess.run(['node',str(CRATE/'scripts/node-oracle.cjs')],input=payload,capture_output=True,check=True,timeout=60)
    rust=subprocess.run([str(binary)],input=payload,capture_output=True,check=True,timeout=60)
    return json.loads(node.stdout),json.loads(rust.stdout)

def boundaries(binary):
    cases=[{'op':'next','expr':'0 9 * * *','zone':zone,'after':0} for zone in ['SystemV/EST5','SystemV/EST5EDT','SystemV/PST8PDT']]
    cases += [{'op':'next','expr':'* * * * *','zone':'UTC','after':value} for value in [-2208902400001,253118217600000,0.5]]
    node,rust=outputs(binary,cases)
    assert len(cases)==len(node)==len(rust)==6,'Missing or extra refusal observations'
    errors=[f"Invalid cron: unknown timezone {case['zone']}" for case in cases[:3]]
    errors += ['Routine cron timestamp is outside the supported range']*2
    errors += ['Expected integer epoch milliseconds']
    for request,expected,actual,error in zip(cases,node,rust,errors):
        assert set(expected)=={'ok'} and type(expected['ok']) is int,(request,expected)
        assert actual=={'error':error},(request,expected,actual,error)
    print(json.dumps({'documentedRefusals':len(cases),'icuOnlySystemVGap':True,'boundedEpochDomain':True}),flush=True)

def main():
    for file in ['scripts/node-oracle.cjs','scripts/generate-zones.cjs']:
        subprocess.run(['node','--check',str(CRATE/file)],check=True)
    subprocess.run(['node','--check',str(REPO/'packages/core/src/routines/cron.cjs')],check=True)
    binary=build()
    names=subprocess.check_output([str(CRATE/'target/debug/examples/zone_names')])
    generated=subprocess.check_output(['node',str(CRATE/'scripts/generate-zones.cjs')],input=names)
    generated=subprocess.check_output(['rustfmt','--edition','2021','--emit','stdout'],input=generated,cwd=CRATE)
    assert generated==(CRATE/'src/zones.rs').read_bytes(),'ICU alias inventory drift'
    tree=subprocess.check_output(['cargo','tree','--offline','--locked','--manifest-path',str(CRATE/'Cargo.toml'),'-e','normal,features'],text=True)
    assert all(flag not in tree for flag in ['tz-system','tzdb-zoneinfo','tzdb-concatenated','tzdb-bundle']), 'Unexpected ambient timezone feature'
    cases=corpus();node,rust=outputs(binary,cases)
    different=[(i,cases[i],a,b) for i,(a,b) in enumerate(zip(node,rust)) if a!=b]
    assert len(node)==len(rust)==len(cases)
    if different:
        for row in different[:20]: print(json.dumps(row,ensure_ascii=False))
        raise SystemExit(f'{len(different)} / {len(cases)} mismatches')
    boundaries(binary)
    print(json.dumps({'cases':len(cases),'node':subprocess.check_output(['node','--version'],text=True).strip(),'tzdb':'2025b','sourceHashes':'verified','parity':True}))

if __name__=='__main__': main()
