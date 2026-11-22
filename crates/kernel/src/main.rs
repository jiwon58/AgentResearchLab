use gajae_logic_engine::{argumentation, formal, grounded, parse_attacks};
use std::{env, process::ExitCode};

#[cfg(windows)]
mod folder_picker;

fn breed(
    mut seed: u32,
    left: u32,
    right: u32,
    mutation_percent: u32,
    crossover_percent: u32,
) -> u32 {
    let mut random = || {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        seed >> 16
    };
    let cross = random() % 100 < crossover_percent;
    let mut child = 0;
    for index in 0..8 {
        let select = if cross && random() % 2 == 0 {
            right
        } else {
            left
        };
        let mut trait_value = (select >> (index * 2)) & 3;
        if random() % 100 < mutation_percent {
            trait_value = (trait_value + 1 + random() % 3) % 4;
        }
        child |= trait_value << (index * 2);
    }
    child
}

fn evaluate(args: &[String]) -> Option<String> {
    match args {
        [version, mode, size, raw] if version == "v1" && mode == "grounded" => {
            let size: usize = size.parse().ok()?;
            let edges = parse_attacks(size, raw)?;
            let result: Vec<_> = grounded(size, &edges)
                .into_iter()
                .map(|id| id.to_string())
                .collect();
            Some(format!("[{}]", result.join(",")))
        }
        [version, mode, rest @ ..] if version == "v1" && mode == "argumentation" => {
            argumentation(rest)
        }
        [version, mode, rest @ ..] if version == "v1" && mode == "formal" => formal(rest),
        [version, mode, seed, a, b, mutation, crossover] if version == "v1" && mode == "breed" => {
            let (seed, a, b, mutation, crossover) = (
                seed.parse().ok()?,
                a.parse().ok()?,
                b.parse().ok()?,
                mutation.parse().ok()?,
                crossover.parse().ok()?,
            );
            if a > 65535 || b > 65535 || mutation > 100 || crossover > 100 {
                return None;
            }
            Some(breed(seed, a, b, mutation, crossover).to_string())
        }
        _ => None,
    }
}

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments == ["v1", "logic-engine-available"] {
        println!("scientific-logic/v1");
        return ExitCode::SUCCESS;
    }
    #[cfg(windows)]
    if arguments == ["v1", "folder-picker-available"] {
        println!("windows-folder-picker/v1");
        return ExitCode::SUCCESS;
    }
    #[cfg(windows)]
    if arguments == ["v1", "pick-folder"] {
        return match folder_picker::choose_folder() {
            Ok(Some(folder)) => {
                println!("{folder}");
                ExitCode::SUCCESS
            }
            Ok(None) => ExitCode::SUCCESS,
            Err(()) => ExitCode::from(3),
        };
    }
    match evaluate(&arguments) {
        Some(result) => {
            println!("{result}");
            ExitCode::SUCCESS
        }
        None => {
            eprintln!("invalid kernel v1 request");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_grounded_extension_and_excludes_cycles() {
        assert_eq!(grounded(5, &[(0, 1), (1, 2), (3, 4), (4, 3)]), [0, 2]);
    }

    #[test]
    fn mutation_is_reproducible_and_bounded() {
        assert_eq!(breed(42, 0x1111, 0xffff, 0, 0), 0x1111);
        assert_eq!(
            breed(42, 0x1111, 0xffff, 30, 50),
            breed(42, 0x1111, 0xffff, 30, 50)
        );
        assert_ne!(breed(42, 0x1111, 0xffff, 100, 0), 0x1111);
    }
}
