import pathlib

p = pathlib.Path("ecosystem.config.cjs")
s = p.read_text(encoding="utf-8")

old_script = '      script: "ngrok",'
new_script = '      script: process.platform === "win32" ? process.env.ComSpec : "ngrok", // Windows: launch via cmd'
old_args = '      args: `http --url=${DOMAIN} ${PORT}`,'
new_args = ('      args: process.platform === "win32"\n'
            '        ? `/c ngrok http --url=${DOMAIN} ${PORT}`\n'
            '        : `http --url=${DOMAIN} ${PORT}`,')

assert old_script in s and old_args in s, "ecosystem.config.cjs is not in the expected shape"
p.write_text(s.replace(old_script, new_script).replace(old_args, new_args), encoding="utf-8")
print("ecosystem.config.cjs patched")