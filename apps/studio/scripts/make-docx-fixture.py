
from docx import Document
doc = Document()
doc.add_heading("GDD 摘要", level=1)
doc.add_paragraph("核心玩法：自动攻击 + 波次生存，单局 5 分钟。")
doc.add_paragraph("目标平台：微信小游戏。角色是鸽子，可飞行与俯冲。")
p = doc.add_paragraph("特殊字符测试：")
p.add_run("A & B < C > D \"quoted\" 'single'")
doc.add_heading("波次结构", level=2)
doc.add_paragraph("每 30 秒一波，第 10 波出现 Boss。")
doc.save(r"H:\\AI与开发\\ai_game_studio_starter\\apps\\studio\\test\\fixtures\\sample.docx")
print("saved")
