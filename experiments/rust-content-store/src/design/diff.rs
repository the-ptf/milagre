use super::*;
fn serialized_equal(a: &Value, b: &Value) -> bool {
    jsjson::to_string(a) == jsjson::to_string(b)
}
/// Minimal stable edit batch when it reproduces the exact resolved source;
/// otherwise preserve the document with the production replace fallback.
pub fn document_diff(before: &Value, after: &Value) -> Result<Value> {
    let a = validate_document(before)?;
    let b = validate_document(after)?;
    if serialized_equal(&a, &b) {
        return Ok(json!([]));
    }
    let replace = || json!([{"op":"replace","document":b}]);
    let mut old_meta = a.clone();
    remove(&mut old_meta, "nodes");
    let mut new_meta = b.clone();
    remove(&mut new_meta, "nodes");
    if !serialized_equal(&old_meta, &new_meta) {
        return Ok(replace());
    }
    let old = nodes(&a)
        .iter()
        .map(|node| (sid(node, "id"), node))
        .collect::<BTreeMap<_, _>>();
    let new = nodes(&b)
        .iter()
        .map(|node| (sid(node, "id"), node))
        .collect::<BTreeMap<_, _>>();
    let old_order = nodes(&a)
        .iter()
        .filter(|node| new.contains_key(&sid(node, "id")))
        .map(|node| sid(node, "id"))
        .collect::<Vec<_>>();
    let new_order = nodes(&b)
        .iter()
        .filter(|node| old.contains_key(&sid(node, "id")))
        .map(|node| sid(node, "id"))
        .collect::<Vec<_>>();
    if old_order != new_order {
        return Ok(replace());
    }
    if nodes(&b).iter().any(|node| {
        old.get(&sid(node, "id"))
            .is_some_and(|old| yes(old, "parentId") && !new.contains_key(&sid(old, "parentId")))
    }) {
        return Ok(replace());
    }
    let mut operations = vec![];
    for node in nodes(&a) {
        let id = sid(node, "id");
        if components::instance(&a, &id).is_some_and(|root| root["id"] != id) {
            continue;
        }
        if !new.contains_key(&id)
            && (!yes(node, "parentId") || new.contains_key(&sid(node, "parentId")))
        {
            operations.push(json!({"op":"delete","id":id}));
        }
    }
    for (index, node) in nodes(&b).iter().enumerate() {
        let id = sid(node, "id");
        let instance = components::instance(&b, &id);
        if instance.as_ref().is_some_and(|root| root["id"] != id) {
            continue;
        }
        let Some(previous) = old.get(&id) else {
            operations.push(json!({"op":"insert","node":node,"index":index}));
            continue;
        };
        if object(previous).keys().any(|field| !has(node, field)) {
            return Ok(replace());
        }
        let patch = object(node)
            .iter()
            .filter(|(field, value)| {
                field.as_str() != "id"
                    && (value.is_object()
                        || value.is_array()
                        || previous
                            .get(*field)
                            .is_none_or(|old| !jsjson::strict_equals(old, value)))
                    && (instance.is_none()
                        || [
                            "x",
                            "y",
                            "parentId",
                            "name",
                            "hidden",
                            "locked",
                            "componentValues",
                        ]
                        .contains(&field.as_str()))
            })
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect::<Map<_, _>>();
        if !patch.is_empty() {
            operations.push(json!({"op":"update","id":id,"patch":patch}));
        }
    }
    let operations = json!(operations);
    if apply_operations(&a, &operations, None).is_ok_and(|result| serialized_equal(&result, &b)) {
        Ok(operations)
    } else {
        Ok(replace())
    }
}
