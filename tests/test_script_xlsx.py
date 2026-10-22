# -*- coding: utf-8 -*-
"""The script as a spreadsheet (GET /api/dub/jobs/{jid}/script.xlsx in
app/api/script.py): the file Perso's web app downloads, laid out the same --
one sheet, the header row speaker_id | start_time | end_time |
original_segment | translated_segment, then a row per line, every cell an
inline string -- and named the way Perso names it."""
import json
import xml.etree.ElementTree as ET
import zipfile
from io import BytesIO
from urllib.parse import unquote

from fastapi.testclient import TestClient

from app import perso_client, state
from app.main import app
from app.text.srt import build_srt

client = TestClient(app, base_url="http://127.0.0.1")
MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
HEAD = ["speaker_id", "start_time", "end_time", "original_segment", "translated_segment"]


def _job(tmp_path, translated, original=(), speakers=None, edited=None, **fields):
    """A finished dub with its script in its folder, and the job's id."""
    work = tmp_path / "work"
    work.mkdir(parents=True)
    (work / "translated.srt").write_text(build_srt(translated), encoding="utf-8")
    if original:
        (work / "original.srt").write_text(build_srt(original), encoding="utf-8")
    if edited:
        (work / "edited.srt").write_text(build_srt(edited), encoding="utf-8")
    if speakers is not None:
        (work / "speakers.json").write_text(json.dumps(speakers), encoding="utf-8")
    jid = state.job_store.create()
    state.job_store.update(jid, **{"status": "done", "work_dir": str(work), "project": "clip_en",
                                   "language_code": "en", "source_lang": "ko",
                                   "result": {"out_path": str(work / "dubbed.mp4")}, **fields})
    return jid


def _cue(start, end, text):
    return {"start": start, "end": end, "text": text}


def _rows(body):
    """The sheet's rows, each a list of its cells' text -- once the zip is
    whole, holds the five parts an .xlsx needs, and every part reads as XML."""
    z = zipfile.ZipFile(BytesIO(body))
    assert z.testzip() is None
    assert sorted(z.namelist()) == ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels",
                                    "xl/workbook.xml", "xl/worksheets/sheet1.xml"]
    for name in z.namelist():
        ET.fromstring(z.read(name))
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for n, row in enumerate(sheet.iter(MAIN + "row"), start=1):
        assert row.get("r") == str(n)
        assert [c.get("r") for c in row] == ["%s%d" % (col, n) for col in "ABCDE"]
        assert {c.get("t") for c in row} == {"inlineStr"}
        rows.append([c.find(MAIN + "is").find(MAIN + "t").text or "" for c in row])
    assert sheet.find(MAIN + "dimension").get("ref") == "A1:E%d" % len(rows)
    return rows


def _saved_as(r):
    kind, _, name = r.headers["content-disposition"].partition("; filename*=UTF-8''")
    assert kind == "attachment"
    return unquote(name)


def test_the_sheet_has_the_header_then_a_row_per_line_with_its_times_speaker_and_both_texts(tmp_path):
    jid = _job(
        tmp_path,
        translated=[_cue(0.17, 7.28, "Goodbye, everyone!"), _cue(8.42, 16.61, "Fish & <chips>"),
                    _cue(3725.5, 3730.04, 'Say "bye"')],
        original=[_cue(0.17, 7.28, "안녕히 계세요. 여러분!"), _cue(8.42, 16.61, "생선이랑\x08감자")],
        # Labelled by the diarizer in an order of its own: numbered as they first speak.
        speakers=[{"start": 0.17, "end": 7.28, "speaker": "SPEAKER_07"},
                  {"start": 8.42, "end": 16.61, "speaker": "SPEAKER_02"},
                  {"start": 3725.5, "end": 3730.04, "speaker": "SPEAKER_07"}],
        # A line rewritten on the script screen goes out as it now reads.
        edited=[_cue(0.17, 7.28, "Goodbye, everyone! Be happy!"), _cue(8.42, 16.61, "Fish & <chips>"),
                _cue(3725.5, 3730.04, 'Say "bye"')])
    r = client.get(f"/api/dub/jobs/{jid}/script.xlsx")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert _rows(r.content) == [
        HEAD,
        ["SPEAKER_01", "00:00:00,170", "00:00:07,280", "안녕히 계세요. 여러분!", "Goodbye, everyone! Be happy!"],
        # A character XML cannot hold is left out rather than spoiling the file.
        ["SPEAKER_02", "00:00:08,420", "00:00:16,610", "생선이랑감자", "Fish & <chips>"],
        # No source line under it: an empty cell. Past an hour, the hours count.
        ["SPEAKER_01", "01:02:05,500", "01:02:10,040", "", 'Say "bye"'],
    ]


def test_a_script_nobody_is_labelled_in_is_one_voice_and_an_unlabelled_line_among_others_names_nobody(tmp_path):
    lines = [_cue(0.0, 1.0, "One"), _cue(2.0, 3.0, "Two"), _cue(4.0, 5.0, "Three")]
    jid = _job(tmp_path / "a", translated=lines)
    assert [row[0] for row in _rows(client.get(f"/api/dub/jobs/{jid}/script.xlsx").content)] \
        == ["speaker_id", "SPEAKER_01", "SPEAKER_01", "SPEAKER_01"]
    # The second line's middle falls in no speaker's span.
    jid = _job(tmp_path / "b", translated=lines,
               speakers=[{"start": 0.0, "end": 1.0, "speaker": "A"}, {"start": 4.0, "end": 5.0, "speaker": "B"}])
    assert [row[0] for row in _rows(client.get(f"/api/dub/jobs/{jid}/script.xlsx").content)] \
        == ["speaker_id", "SPEAKER_01", "", "SPEAKER_02"]


def test_the_file_is_named_after_the_project_as_shown_and_both_languages_the_way_perso_names_it(tmp_path):
    lines = [_cue(0.0, 1.0, "Hola")]
    # The name the screens show, with what a file name cannot hold swapped
    # the way a saved download's is (app/downloads.py file_stem); a regional
    # code keeps its region. No timestamp after it, unlike Perso's.
    jid = _job(tmp_path / "a", translated=lines, title=" 안녕히계세요: 츄 퇴사짤 ", language_code="es-MX")
    assert _saved_as(client.get(f"/api/dub/jobs/{jid}/script.xlsx")) \
        == "안녕히계세요 - 츄 퇴사짤_KOtoES-MX_OriginalTranslatedScript.xlsx"
    # Never renamed: the folder's name. A source left on auto-detect that
    # never learned its language says so.
    jid = _job(tmp_path / "b", translated=lines, source_lang=None)
    assert _saved_as(client.get(f"/api/dub/jobs/{jid}/script.xlsx")) \
        == "clip_en_AUTOtoEN_OriginalTranslatedScript.xlsx"


def test_a_perso_dubbing_s_sheet_is_its_script_read_back_from_perso(tmp_path, monkeypatch):
    class Perso:
        def get_project_script(self, seq, space_seq=None):
            assert seq == 409873
            return {"sentences": [
                {"originalText": "안녕", "translatedText": "Hi there", "offsetMs": 270, "durationMs": 5940,
                 "speakerOrderIndex": 0},
                {"originalText": "잘 가", "translatedText": "Bye now", "offsetMs": 6500, "durationMs": 900,
                 "speakerOrderIndex": 1},
            ]}

    monkeypatch.setattr(perso_client, "PersoClient", Perso)
    jid = state.job_store.create()
    state.job_store.update(jid, status="done", dub_mode="perso", perso_project_seq=409873, project="clip_en",
                           language_code="en", source_lang="ko", work_dir=str(tmp_path),
                           result={"out_path": str(tmp_path / "dubbed.mp4")})
    r = client.get(f"/api/dub/jobs/{jid}/script.xlsx")
    assert r.status_code == 200
    # Perso numbers its speakers from 0, and speaker 0 is a speaker.
    assert _rows(r.content) == [HEAD,
                                ["SPEAKER_01", "00:00:00,270", "00:00:06,210", "안녕", "Hi there"],
                                ["SPEAKER_02", "00:00:06,500", "00:00:07,400", "잘 가", "Bye now"]]


def test_no_script_no_spreadsheet(tmp_path):
    assert client.get("/api/dub/jobs/nope/script.xlsx").status_code == 404
    running = state.job_store.create()
    assert client.get(f"/api/dub/jobs/{running}/script.xlsx").status_code == 409
    gone = state.job_store.create()
    state.job_store.update(gone, status="done", result={"out_path": str(tmp_path / "dubbed.mp4")})
    r = client.get(f"/api/dub/jobs/{gone}/script.xlsx")
    assert r.status_code == 404
    assert r.json()["detail"] == "No script was recorded for this project."
