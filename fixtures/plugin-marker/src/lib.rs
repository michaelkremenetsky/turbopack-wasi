use swc_core::ecma::{
    ast::{Ident, Program},
    visit::{VisitMut, VisitMutWith},
};
use swc_core::plugin::{plugin_transform, proxies::TransformPluginProgramMetadata};

/// Renames every `__PLUGIN_MARKER_IN__` identifier to `__PLUGIN_MARKER_OUT__`.
struct Marker;

impl VisitMut for Marker {
    fn visit_mut_ident(&mut self, ident: &mut Ident) {
        if &*ident.sym == "__PLUGIN_MARKER_IN__" {
            ident.sym = "__PLUGIN_MARKER_OUT__".into();
        }
    }
}

#[plugin_transform]
pub fn process(mut program: Program, _metadata: TransformPluginProgramMetadata) -> Program {
    program.visit_mut_with(&mut Marker);
    program
}
