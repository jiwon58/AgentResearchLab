pub type Attack = (usize, usize);

fn defense(size: usize, attacks: &[Attack], selected: &[usize]) -> Vec<usize> {
    let mut countered = vec![false; size];
    for &(source, target) in attacks {
        if selected.contains(&source) {
            countered[target] = true;
        }
    }
    (0..size)
        .filter(|&target| {
            attacks
                .iter()
                .all(|&(source, attacked)| attacked != target || countered[source])
        })
        .collect()
}

pub fn grounded(size: usize, attacks: &[Attack]) -> Vec<usize> {
    let mut selected = Vec::new();
    loop {
        let next = defense(size, attacks, &selected);
        if selected == next {
            return next;
        }
        selected = next;
    }
}

fn integers(raw: &str) -> Option<Vec<i32>> {
    if raw.is_empty() {
        Some(Vec::new())
    } else {
        raw.split(',').map(|value| value.parse().ok()).collect()
    }
}

pub fn parse_attacks(size: usize, raw: &str) -> Option<Vec<Attack>> {
    if size > 128 || raw.len() > 16_384 {
        return None;
    }
    if raw.is_empty() {
        return Some(Vec::new());
    }
    let attacks: Option<Vec<Attack>> = raw
        .split(',')
        .map(|edge| {
            let (a, b) = edge.split_once(':')?;
            let pair = (a.parse().ok()?, b.parse().ok()?);
            (pair.0 < size && pair.1 < size).then_some(pair)
        })
        .collect();
    let attacks = attacks?;
    let unique: std::collections::BTreeSet<_> = attacks.iter().collect();
    (unique.len() == attacks.len()).then_some(attacks)
}

pub fn argumentation(args: &[String]) -> Option<String> {
    let [size, raw, selected] = args else {
        return None;
    };
    let size: usize = size.parse().ok()?;
    let attacks = parse_attacks(size, raw)?;
    if selected.len() > 512 {
        return None;
    }
    let selected: Vec<usize> = integers(selected)?
        .into_iter()
        .map(|n| usize::try_from(n).ok().filter(|&i| i < size))
        .collect::<Option<_>>()?;
    if selected
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != selected.len()
    {
        return None;
    }
    let conflict_free = attacks
        .iter()
        .all(|(a, b)| !selected.contains(a) || !selected.contains(b));
    Some(format!(
        "{{\"accepted\":{:?},\"conflictFree\":{},\"defended\":{:?}}}",
        grounded(size, &attacks),
        conflict_free,
        defense(size, &attacks, &selected)
    ))
}

pub fn formal(args: &[String]) -> Option<String> {
    let [rule, literals, sources, count, antecedent, consequent, conclusion] = args else {
        return None;
    };
    if literals.len() > 512 || sources.len() > 512 {
        return None;
    }
    let literals = integers(literals)?;
    let sources = integers(sources)?;
    let source_count: i32 = count.parse().ok()?;
    let antecedent: i32 = antecedent.parse().ok()?;
    let consequent: i32 = consequent.parse().ok()?;
    let conclusion: i32 = conclusion.parse().ok()?;
    if literals.len() > 24
        || sources.len() != literals.len() + usize::from(rule == "MODUS_PONENS")
        || !(0..=128).contains(&source_count)
        || conclusion == 0
        || literals
            .iter()
            .chain([&antecedent, &consequent, &conclusion])
            .any(|n| !(-64..=64).contains(n))
        || literals.contains(&0)
    {
        return None;
    }
    let mut issues = Vec::new();
    if literals.is_empty()
        || sources
            .iter()
            .any(|source| !(0..source_count).contains(source))
    {
        issues.push("MISSING_PROVENANCE");
    }
    if literals.iter().any(|literal| literals.contains(&-literal)) {
        issues.push("CONTRADICTORY_PREMISES");
    }
    match rule.as_str() {
        "FACT" if !literals.contains(&conclusion) => issues.push("INVALID_INFERENCE"),
        "MODUS_PONENS" if !literals.contains(&antecedent) || consequent != conclusion => {
            issues.push("INVALID_INFERENCE")
        }
        "FACT" | "MODUS_PONENS" => (),
        _ => issues.push("UNSUPPORTED_RULE"),
    }
    Some(format!("{issues:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutual_attacks_and_defense_sets() {
        assert!(grounded(2, &[(0, 1), (1, 0)]).is_empty());
        assert_eq!(grounded(3, &[(0, 1), (1, 0), (2, 1)]), vec![0, 2]);
        assert!(parse_attacks(3, "0:1,0:1").is_none());
        assert!(parse_attacks(3, "0:3").is_none());
        let output = argumentation(&["3", "0:1,1:0,2:1", "0,1"].map(str::to_owned)).unwrap();
        assert!(output.contains("\"conflictFree\":false"));
    }

    #[test]
    fn checks_inference_and_provenance_independently() {
        assert_eq!(
            formal(&["MODUS_PONENS", "1", "0,1", "2", "1", "2", "2"].map(str::to_owned)).unwrap(),
            "[]"
        );
        let failures =
            formal(&["MODUS_PONENS", "1,-1", "0,-1,0", "1", "3", "2", "2"].map(str::to_owned))
                .unwrap();
        assert!(
            failures.contains("MISSING_PROVENANCE")
                && failures.contains("CONTRADICTORY_PREMISES")
                && failures.contains("INVALID_INFERENCE")
        );
    }
}
