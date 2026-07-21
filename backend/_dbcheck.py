import shutil
import sqlite3

shutil.copy('instance/serverkit.db', 'instance/sandbox-smoke.db')
src = sqlite3.connect('instance/serverkit.db')
try:
    rows = src.execute('PRAGMA integrity_check').fetchall()
    print('integrity:', rows[:5])
except Exception as e:
    print('integrity check failed:', e)
