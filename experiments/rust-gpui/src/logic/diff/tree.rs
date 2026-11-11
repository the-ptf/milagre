//! `diff-tree.ts`: the folder tree of the changed files.

use super::collate::locale_compare;

/// What the tree needs of a changed file; `DiffFileEntry` implements it.
pub trait Counted {
    fn path(&self) -> &str;
    fn added(&self) -> u32;
    fn removed(&self) -> u32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffTreeFolder<T> {
    pub name: String,
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub children: Vec<DiffTreeNode<T>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffTreeNode<T> {
    File { name: String, path: String, file: T },
    Folder(DiffTreeFolder<T>),
}

impl<T> DiffTreeNode<T> {
    pub fn name(&self) -> &str {
        match self {
            Self::File { name, .. } => name,
            Self::Folder(folder) => &folder.name,
        }
    }
}

fn folder_node<T>(name: &str, path: String) -> DiffTreeFolder<T> {
    DiffTreeFolder { name: name.to_string(), path, added: 0, removed: 0, children: Vec::new() }
}

/// Nested folders with summed counts. A folder holding only one folder is merged into it ("src/components").
pub fn build_diff_tree<T: Counted + Clone>(files: &[T]) -> Vec<DiffTreeNode<T>> {
    let mut root: DiffTreeFolder<T> = folder_node("", String::new());
    for file in files {
        let mut parts: Vec<&str> = file.path().split('/').collect();
        let name = parts.pop().unwrap_or("");
        let mut folder = &mut root;
        for (i, folder_name) in parts.iter().enumerate() {
            let path = parts[..=i].join("/");
            let index = match folder.children.iter().position(|c| matches!(c, DiffTreeNode::Folder(f) if f.path == path)) {
                Some(index) => index,
                None => {
                    folder.children.push(DiffTreeNode::Folder(folder_node(folder_name, path)));
                    folder.children.len() - 1
                }
            };
            let DiffTreeNode::Folder(next) = &mut folder.children[index] else { unreachable!("index points at a folder") };
            next.added = next.added.saturating_add(file.added());
            next.removed = next.removed.saturating_add(file.removed());
            folder = next;
        }
        folder.children.push(DiffTreeNode::File { name: name.to_string(), path: file.path().to_string(), file: file.clone() });
    }
    finish(root.children)
}

fn finish<T>(nodes: Vec<DiffTreeNode<T>>) -> Vec<DiffTreeNode<T>> {
    let mut sorted: Vec<DiffTreeNode<T>> = nodes
        .into_iter()
        .map(|node| match node {
            DiffTreeNode::File { .. } => node,
            DiffTreeNode::Folder(mut folder) => {
                while folder.children.len() == 1 && matches!(folder.children[0], DiffTreeNode::Folder(_)) {
                    let Some(DiffTreeNode::Folder(only)) = folder.children.pop() else { unreachable!("checked above") };
                    folder = DiffTreeFolder { name: format!("{}/{}", folder.name, only.name), ..only };
                }
                let children = finish(std::mem::take(&mut folder.children));
                DiffTreeNode::Folder(DiffTreeFolder { children, ..folder })
            }
        })
        .collect();
    // Folders first, then each kind by name; the sort is stable like JavaScript's.
    sorted.sort_by(|a, b| match (a, b) {
        (DiffTreeNode::Folder(_), DiffTreeNode::File { .. }) => std::cmp::Ordering::Less,
        (DiffTreeNode::File { .. }, DiffTreeNode::Folder(_)) => std::cmp::Ordering::Greater,
        _ => locale_compare(a.name(), b.name()),
    });
    sorted
}
