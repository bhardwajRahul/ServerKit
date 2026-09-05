#!/usr/bin/env python3
"""Render all README measurement tables from the same reviewed JSON snapshots.

Run with --write after refreshing docs/measurements/*.json; without it, check
that all four language versions match. This validates documentation agreement,
not whether a stored build was rebuilt from the current checkout.
"""

import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
BEGIN = '<!-- BEGIN GENERATED MEASUREMENTS -->'
END = '<!-- END GENERATED MEASUREMENTS -->'


def blocks(source, build):
    date = source['measured_at_utc'][:10]
    routes = source['core_route_declarations']
    blueprints = source['core_blueprint_declarations']
    templates = source['bundled_app_templates']
    tests = source['backend_tests_clean_collected']
    if tests is None:
        raise ValueError('Refresh repository.json with --collect-tests before publishing counts')
    total = build['all_code']['gzip_bytes'] / 1_000_000
    en = [
        f'Snapshot: **{date}**. [Definitions, raw measurements and reproduction commands](docs/METRICS.md).',
        f'| **{routes:,}** core route declarations | in **{blueprints}** blueprint declarations under `backend/app/api`; source inventory, excluding extensions |',
        f'| **{templates}** bundled app templates | root-level app YAML files; database extension templates counted separately |',
        f'| **{tests:,}** backend test cases collected | clean-checkout collection; this is not a claim that every case passed or ran |',
        f'| **{total:.2f} MB** total JS/CSS, gzipped | includes lazy chunks, locale bundles and vendor shims; excludes fonts and images |',
        '| **$0** license cost | MIT-licensed, without subscription or seat fees |',
        'The total sums files individually compressed with gzip at level 9; it is not a measured page-load time. RAM usage and image size depend on the build, platform and workload; no universal footprint is claimed.',
    ]
    es = [
        f'Instantánea: **{date}**. [Definiciones, medidas y comandos para reproducirlas](METRICS.md).',
        f'| **{routes:,}** declaraciones de rutas del núcleo | en **{blueprints}** declaraciones de blueprints de `backend/app/api`; inventario del código, sin extensiones |',
        f'| **{templates}** plantillas de apps incluidas | archivos YAML de apps en el directorio raíz; las plantillas de extensiones de bases de datos se cuentan aparte |',
        f'| **{tests:,}** casos de prueba de backend recopilados | recopilación de un checkout limpio; no significa que todos se hayan ejecutado o aprobado |',
        f'| **{total:.2f} MB** de JS/CSS en total, comprimido con gzip | incluye módulos diferidos, idiomas y adaptadores de dependencias; excluye fuentes e imágenes |',
        '| **$0** de licencia | Licencia MIT, sin suscripciones ni tarifas por usuario |',
        'Los valores gzip suman archivos comprimidos por separado a nivel 9; no son tiempos de carga medidos. La RAM y el tamaño de imagen dependen de la compilación, plataforma y carga de trabajo.',
    ]
    pt = [
        f'Registro: **{date}**. [Definições, medições e comandos de reprodução](METRICS.md).',
        f'| **{routes:,}** declarações de rotas do núcleo | em **{blueprints}** declarações de blueprints em `backend/app/api`; inventário do código, sem extensões |',
        f'| **{templates}** templates de apps incluídos | arquivos YAML de apps no diretório raiz; templates de extensões de banco são contados separadamente |',
        f'| **{tests:,}** casos de teste de backend coletados | coleta de um checkout limpo; não significa que todos executaram ou passaram |',
        f'| **{total:.2f} MB** de JS/CSS no total, comprimido com gzip | inclui módulos sob demanda, idiomas e adaptadores de dependências; exclui fontes e imagens |',
        '| **$0** de licença | Licença MIT, sem assinaturas ou taxas por usuário |',
        'Os valores gzip somam arquivos comprimidos separadamente no nível 9; não são tempos de carregamento medidos. A RAM e o tamanho da imagem dependem da compilação, plataforma e carga de trabalho.',
    ]
    zh = [
        f'测量快照：**{date}**。[定义、原始测量结果和复现命令](METRICS.md)。',
        f'| **{routes:,}** 个核心路由声明 | 来自 `backend/app/api` 中 **{blueprints}** 个蓝图声明；这是源码清单，不包括扩展 |',
        f'| **{templates}** 个内置应用模板 | 模板目录根层级的应用 YAML 文件；数据库扩展模板另计 |',
        f'| **{tests:,}** 个已收集的后端测试用例 | 基于干净检出的测试收集结果；不代表所有用例均已运行或通过 |',
        f'| **{total:.2f} MB** 全部 JS/CSS 的 gzip 压缩总大小 | 包括按需模块、语言包和依赖适配文件；不含字体和图片 |',
        '| **$0** 许可费用 | MIT 许可证，无订阅或席位费用 |',
        'gzip 数值为各文件分别按级别 9 压缩后的总和，并非实测页面加载时间。内存占用与镜像大小取决于构建、平台和工作负载，不作通用占用保证。',
    ]
    result = {}
    for path, rows in [('README.md', en), ('docs/README.es.md', es), ('docs/README.pt.md', pt), ('docs/README.zh-CN.md', zh)]:
        if path.endswith(('.es.md', '.pt.md')):
            for old, new in [(f'{routes:,}', f'{routes:,}'.replace(',', '.')),
                             (f'{tests:,}', f'{tests:,}'.replace(',', '.')),
                             (f'{total:.2f} MB', f'{total:.2f} MB'.replace('.', ','))]:
                rows = [row.replace(old, new) for row in rows]
        result[path] = '\n'.join([BEGIN, rows[0], '', '| | |', '|---|---|', *rows[1:-1], '', rows[-1], END])
    return result


def update(write=False):
    source = json.loads((ROOT / 'docs/measurements/repository.json').read_text(encoding='utf-8'))
    build = json.loads((ROOT / 'docs/measurements/frontend-build.json').read_text(encoding='utf-8'))
    stale = []
    for path, block in blocks(source, build).items():
        file = ROOT / path
        original = file.read_text(encoding='utf-8')
        if BEGIN in original:
            result = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END), lambda _match: block, original, flags=re.S)
        else:
            result, count = re.subn(r'(^## 📊[^\n]*\n\n).*?(\n---\n)', lambda match: match[1] + block + '\n' + match[2], original, count=1, flags=re.S | re.M)
            if count != 1:
                raise ValueError(f'{path}: cannot find the measurements section')
        if result != original:
            stale.append(path)
            if write:
                file.write_text(result, encoding='utf-8')
    if stale and not write:
        raise SystemExit('README measurements are stale: ' + ', '.join(stale))
    print(('Updated' if write else 'Checked') + ' all four README measurement tables.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    update(parser.parse_args().write)
