"""Read native XML evidence; never load app/config/test code or launch a process."""
from collections import Counter
import xml.etree.ElementTree as ET


def parse_junit(data):
    assert data and len(data) <= 16 * 1024 * 1024
    assert b'<!DOCTYPE' not in data and b'<!ENTITY' not in data
    root = ET.fromstring(data)
    assert root.tag == 'testsuites' and root.get('name') == 'bun test'
    cases = []

    def count_attr(element, key):
        value = element.get(key)
        assert value is not None and value.isascii() and value.isdecimal()
        return int(value)

    def visit(element, file, ancestors):
        before = len(cases)
        for child in element:
            if child.tag == 'properties':
                assert all(item.tag == 'property' for item in child)
            elif child.tag == 'testsuite':
                name = child.get('name')
                assert isinstance(name, str) and name
                visit(child, file, ancestors + [name])
            elif child.tag == 'testcase':
                title = child.get('name')
                assert isinstance(title, str) and title
                assert child.get('file') == file
                assert child.get('classname') == ' > '.join(reversed(ancestors))
                assert all(item.tag in ('failure', 'skipped') for item in child)
                assert len(child) <= 1
                status = 'passed'
                if len(child):
                    if child[0].tag == 'failure':
                        status = 'failed'
                    elif child[0].get('message') == 'TODO':
                        status = 'todo'
                    else:
                        status = 'skipped'
                cases.append({'file': file, 'title': title,
                              'ancestorTitles': list(ancestors),
                              'fullName': ' '.join(ancestors + [title]),
                              'status': status, 'nativeAttributes': dict(child.attrib),
                              'failureAttributes': dict(child[0].attrib) if len(child) else None,
                              'assertions': count_attr(child, 'assertions')})
            else:
                raise AssertionError('Unsupported JUnit element: ' + child.tag)
        selected = cases[before:]
        assert selected, 'Every reported file/suite must contain cases'
        assert count_attr(element, 'tests') == len(selected)
        assert count_attr(element, 'failures') == sum(row['status'] == 'failed' for row in selected)
        assert count_attr(element, 'skipped') == sum(row['status'] in ('skipped', 'todo') for row in selected)
        assert count_attr(element, 'assertions') == sum(row['assertions'] for row in selected)

    for file_suite in root:
        assert file_suite.tag == 'testsuite'
        file = file_suite.get('name')
        assert isinstance(file, str) and file and '\\' not in file
        assert not file.startswith('/') and '..' not in file.split('/')
        visit(file_suite, file, [])
    assert cases
    assert count_attr(root, 'tests') == len(cases)
    assert count_attr(root, 'failures') == sum(row['status'] == 'failed' for row in cases)
    assert count_attr(root, 'skipped') == sum(row['status'] in ('skipped', 'todo') for row in cases)
    assert count_attr(root, 'assertions') == sum(row['assertions'] for row in cases)
    return cases


def native_multiset(rows, files):
    return Counter((row['file'], row['title'], tuple(row['ancestorTitles']),
                    row['fullName'], row['status'])
                   for row in rows if row['file'] in files)


def stock_multiset(case_map, files):
    rows = []
    assert set(files) <= set(case_map)
    for file in files:
        assert case_map[file]
        for case in case_map[file]:
            assert case['fullName'] == ' '.join(case['ancestorTitles'] + [case['title']])
            assert all(not any(ord(char) < 32 and char not in '\t\r\n' for char in title)
                       for title in case['ancestorTitles'] + [case['title']])
            rows.append({'file': file, **case})
    return native_multiset(rows, files)
