import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ServerIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  toggleSidebarEnvironmentScope,
  type SidebarEnvironmentScopeOption,
} from "../Sidebar.logic";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function SidebarEnvironmentScopeMenu(props: {
  readonly options: readonly SidebarEnvironmentScopeOption[];
  readonly scope: ReadonlySet<EnvironmentId> | null;
  readonly machineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly onScopeChange: (environmentIds: readonly EnvironmentId[]) => void;
}) {
  const { options, scope, machineById, onScopeChange } = props;
  const gt = useGT();
  const scopedOptions = scope === null ? [] : options.filter((o) => scope.has(o.environmentId));
  const onlyScoped = scopedOptions.length === 1 ? scopedOptions[0] : undefined;
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              scope === null
                ? gt("Environments")
                : gt("Environments: {environments}", {
                    environments: scopedOptions.map((option) => option.label).join(", "),
                  })
            }
          />
        }
      >
        {onlyScoped ? (
          <EnvironmentMachineIcon
            kind={machineById.get(onlyScoped.environmentId) ?? "server"}
            className="size-4"
          />
        ) : (
          <ServerIcon className="size-4" />
        )}
        {scope === null ? null : (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
          />
        )}
      </MenuTrigger>
      <MenuPopup align="start" className="w-[min(16rem,var(--available-width))]">
        <MenuCheckboxItem
          checked={scope === null}
          closeOnClick={false}
          onCheckedChange={() => onScopeChange([])}
        >
          <T>All environments</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {options.map((option) => (
          <MenuCheckboxItem
            key={option.environmentId}
            checked={scope === null || scope.has(option.environmentId)}
            closeOnClick={false}
            onCheckedChange={() =>
              onScopeChange(toggleSidebarEnvironmentScope(scope, option.environmentId, options))
            }
          >
            <span className="min-w-0 truncate">{option.label}</span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
