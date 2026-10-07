import { useState } from "react";
import type { PiRequest } from "./types";
export default function AgentForm({ schema, disabled, onSend, onNative }: { schema: PiRequest["schema"]; disabled: boolean; onSend: (value: Record<string, unknown>) => void; onNative: () => void }) {
  const fields = Object.entries(schema?.properties || {});
  const [values, setValues] = useState<Record<string, any>>(() => Object.fromEntries(fields.filter(([, field]) => field.default !== undefined).map(([name, field]) => [name, field.default])));
  const unsupported = fields.some(([, field]) => !["string", "boolean", "number", "integer", "array"].includes(field.type) || (field.type === "array" && !field.items?.enum && !field.items?.oneOf));
  if (unsupported || !schema?.properties) return <div><p>Cancel this form and retry it in Native CLI.</p><button className="primary" disabled={disabled} onClick={onNative}>Cancel and open Native CLI</button></div>;
  return <form onSubmit={(event) => { event.preventDefault(); onSend(Object.fromEntries(fields.filter(([name]) => values[name] !== undefined && values[name] !== "").map(([name, field]) => [name, ["number", "integer"].includes(field.type) ? Number(values[name]) : values[name]]))); }}>
    {fields.map(([name, field]) => {
      const required = schema.required?.includes(name), options = field.enum || field.oneOf?.map((choice: any) => choice.const), itemOptions = field.items?.enum || field.items?.oneOf?.map((choice: any) => choice.const);
      return <label className="field" key={name}><span>{field.title || name}{required ? " *" : ""}</span>{field.description && <small>{field.description}</small>}
        {field.type === "boolean" ? <select required={required} disabled={disabled} value={values[name] === undefined ? "" : String(values[name])} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value === "" ? undefined : event.target.value === "true" }))}><option value="">Choose…</option><option value="true">Yes</option><option value="false">No</option></select>
        : field.type === "array" ? <select multiple required={required} disabled={disabled} value={(values[name] || []).map((value: unknown) => String(itemOptions?.indexOf(value)))} onChange={(event) => setValues((old) => ({ ...old, [name]: Array.from(event.target.selectedOptions).map((option) => itemOptions?.[Number(option.value)]) }))}>{itemOptions?.map((value: unknown, index: number) => <option key={index} value={String(index)}>{String(value)}</option>)}</select>
        : options ? <select required={required} disabled={disabled} value={values[name] === undefined ? "" : String(options.indexOf(values[name]))} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value === "" ? undefined : options[Number(event.target.value)] }))}><option value="">Choose…</option>{options.map((value: unknown, index: number) => <option key={index} value={String(index)}>{String(value)}</option>)}</select>
        : <input required={required} disabled={disabled} type={field.type === "string" ? field.writeOnly || field.format === "password" ? "password" : field.format === "email" ? "email" : field.format === "uri" ? "url" : "text" : "number"} step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} value={values[name] ?? ""} onChange={(event) => setValues((old) => ({ ...old, [name]: event.target.value }))} />}</label>;
    })}
    <div className="dialog-actions"><button type="submit" className="primary" disabled={disabled}>Send response</button></div>
  </form>;
}
