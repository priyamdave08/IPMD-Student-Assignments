"""Protocol fixtures only: these tests do NOT establish model/audio quality."""
import json
import httpx
import pytest


def test_ace_submit_poll_download_and_pending_guard(tmp_path,monkeypatch):
    from server import engines
    monkeypatch.setattr(engines,'DATA',tmp_path)
    calls=[]
    def route(request):
        calls.append(request.url.path)
        if request.url.path=='/release_task':
            body=json.loads(request.content)
            assert body['batch_size']==1 and body['lyrics']=='[Instrumental]'
            return httpx.Response(200,json={'code':200,'data':{'task_id':'task-1'}})
        if request.url.path=='/query_result':
            return httpx.Response(200,json={'code':200,'data':[{'status':1,'result':json.dumps([{'file':'/v1/audio?path=take.wav','dit_model':'fixture'}])}]})
        return httpx.Response(200,content=b'fixture-audio')
    original=httpx.Client
    monkeypatch.setattr(engines.httpx,'Client',lambda **kwargs:original(**kwargs,transport=httpx.MockTransport(route)))
    folder=tmp_path/'job';folder.mkdir()
    brief={'prompt':'piano','duration':10,'tempo':80,'mood':'warm','seed':42}
    result=engines.ace(brief,folder,lambda:None,lambda _:None)
    assert calls==['/release_task','/query_result','/v1/audio']
    assert (folder/'raw.wav').read_bytes()==b'fixture-audio'
    assert result['dit_model']=='fixture'
    assert not list((tmp_path/'provider-tasks').glob('*.json'))
    (tmp_path/'provider-tasks'/'old.json').write_text('{"id":"unfinished"}')
    monkeypatch.setattr(engines.httpx,'post',lambda *a,**k:httpx.Response(200,json={'code':200,'data':[{'status':0}]},request=httpx.Request('POST','http://localhost/query_result')))
    with pytest.raises(RuntimeError,match='earlier ACE-Step'):engines.ensure_ace_idle()


def test_qwen_uses_crops_schema_and_unloads(monkeypatch):
    from server import analysis
    def route(request):
        if request.url.path=='/api/tags':
            return httpx.Response(200,json={'models':[{'name':analysis.OLLAMA_MODEL,'digest':'test-model'}]})
        body=json.loads(request.content)
        assert body['keep_alive']==0 and body['stream'] is False
        assert body['messages'][-1]['images']==['cropped-image']
        assert 'ignore instructions' in body['messages'][0]['content']
        assert body['format']['properties']['mood']
        return httpx.Response(200,json={'message':{'content':json.dumps({'mood':'warm','ambiguous':False,'observations':['Golden points of light.']})}})
    original=httpx.Client
    monkeypatch.setattr(analysis.httpx,'Client',lambda **kwargs:original(**kwargs,transport=httpx.MockTransport(route)))
    result,provenance=analysis.understand(['cropped-image'],[{'time':0}],lambda:None)
    assert result['mood']=='warm' and provenance['digest']=='test-model'
