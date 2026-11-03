import { fireEvent,render,screen,cleanup } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { EvaluationCaseEditor } from './EvaluationCaseEditor';
afterEach(cleanup);
const change=(label:string,value:string) => fireEvent.change(screen.getByLabelText(label),{ target:{ value } });
function setup() {
  const save=vi.fn(); render(<EvaluationCaseEditor datasetId={42} saving={false} onSave={save} />);
  change('Case name','checkout'); change('Task','Summarize incident'); change('Expected value 1','checkout');
  return save;
}
describe('guided evaluation cases',() => {
  it('saves reference text and typed mandatory criteria without authoring JSON',() => {
    const save=setup(); change('Reference context (optional)','checkout is unavailable');
    change('Expected answer / reviewer notes (optional)','Human reference');
    fireEvent.click(screen.getByRole('button',{ name:'Add criterion' }));
    change('Check 2','json_field_equals'); change('JSON field path 2','incident.severity');
    change('Value type 2','number'); change('Expected value 2','3');
    fireEvent.click(screen.getByRole('button',{ name:'Add case' }));
    expect(save).toHaveBeenCalledWith(42,expect.objectContaining({ case_key:'checkout',input:'Summarize incident',context:'checkout is unavailable',expected_output:'Human reference',
      rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_includes',value:'checkout' },{ type:'json_field_equals',path:['incident','severity'],value:3 }] } }));
  });
  it('rejects unsafe paths and invalid typed values before dispatch',() => {
    const save=setup(); change('Check 1','json_field_equals'); change('JSON field path 1','constructor.secret');
    fireEvent.click(screen.getByRole('button',{ name:'Add case' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid JSON field path'); expect(save).not.toHaveBeenCalled();
    change('JSON field path 1','severity'); change('Value type 1','number'); change('Expected value 1','NaN');
    fireEvent.click(screen.getByRole('button',{ name:'Add case' }));
    expect(screen.getByRole('alert')).toHaveTextContent('finite numeric'); expect(save).not.toHaveBeenCalled();
  });
  it('keeps advanced JSON optional and rejects syntax errors',() => {
    const save=setup(); fireEvent.click(screen.getByRole('button',{ name:'Advanced JSON' }));
    expect((screen.getByLabelText('Advanced case JSON') as HTMLTextAreaElement).value).toContain('argus.deterministic.v1');
    change('Advanced case JSON','{'); fireEvent.click(screen.getByRole('button',{ name:'Add case' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid JSON'); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{ name:'Back to form values' }));
    expect(screen.getByLabelText('Case name')).toHaveValue('checkout');
  });
});
